package crawler

import (
	"encoding/json"
	"net/url"
	"sort"
	"strings"
)

type Candidate struct {
	URL             *url.URL
	Depth           int
	DiscoveryOrder  int
	DiscoveredFrom  string
	AnchorText      string
	Placement       string
	InNavigation    bool
	FromSitemap     bool
	SitemapPriority float64
	LocalePriority  int
	Score           int
}

type BusinessPageRole string

const (
	BusinessPageHomepage BusinessPageRole = "homepage"
	BusinessPageAbout    BusinessPageRole = "about"
	BusinessPageOffering BusinessPageRole = "offering"
	BusinessPagePricing  BusinessPageRole = "pricing"
	BusinessPageProof    BusinessPageRole = "proof"
	BusinessPageContact  BusinessPageRole = "contact"
	BusinessPageContent  BusinessPageRole = "content"
	BusinessPageUtility  BusinessPageRole = "utility"
	BusinessPageOther    BusinessPageRole = "other"
)

func ScoreCandidate(candidate Candidate) int {
	u := candidate.URL
	if u == nil {
		return -1000
	}
	score := 0
	cleanPath := strings.Trim(u.Path, "/")
	segments := 0
	if cleanPath != "" {
		segments = len(strings.Split(cleanPath, "/"))
	}

	if cleanPath == "" {
		score += 100
	}
	if candidate.InNavigation {
		score += 35
	}
	if candidate.FromSitemap {
		score += 15
		score += int(candidate.SitemapPriority * 20)
	}
	score += candidate.LocalePriority
	score += max(0, 20-candidate.Depth*5)
	score += max(0, 12-segments*3)

	switch CandidateBusinessRole(candidate) {
	case BusinessPageAbout:
		score += 30
	case BusinessPageOffering:
		score += 30
	case BusinessPagePricing:
		score += 28
	case BusinessPageProof:
		score += 20
	case BusinessPageContact:
		score += 10
	case BusinessPageContent:
		score -= 25
	case BusinessPageUtility:
		score -= 80
	}
	if u.RawQuery != "" {
		score -= 15
	}
	return score
}

func ScorePage(page Page) int {
	score := page.Score
	if page.Title != "" {
		score += 8
	}
	if page.Description != "" {
		score += 5
	}
	if len(page.H1) == 1 {
		score += 5
	}
	if len(page.StructuredData) > 0 {
		score += 8
	}
	if len(page.MainText) > 500 {
		score += 8
	}
	if page.StatusCode < 200 || page.StatusCode >= 400 {
		score -= 100
	}
	return score
}

func SortCandidates(candidates []Candidate) {
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].Score == candidates[j].Score {
			return candidates[i].URL.String() < candidates[j].URL.String()
		}
		return candidates[i].Score > candidates[j].Score
	})
}

func CandidateBusinessRole(candidate Candidate) BusinessPageRole {
	return classifyBusinessPage(candidate.URL, candidate.AnchorText)
}

func PageBusinessRole(page Page) BusinessPageRole {
	pageURL, _ := url.Parse(firstNonEmpty(page.FinalURL, page.URL))
	if localizedLanguageRoot(pageURL, page.Language) {
		return BusinessPageHomepage
	}
	text := strings.Join(
		[]string{page.Title, page.Description, strings.Join(page.H1, " ")},
		" ",
	)
	role := classifyBusinessPage(pageURL, text)
	if role == BusinessPageOther && pageHasExplicitPricingEvidence(page) {
		role = BusinessPagePricing
	}
	if role == BusinessPageHomepage || role == BusinessPageAbout ||
		role == BusinessPagePricing || role == BusinessPageUtility ||
		role == BusinessPageContent {
		return role
	}
	if pageLooksLikeTutorial(page) {
		return BusinessPageContent
	}
	if pageLooksEditorial(page) &&
		!(role == BusinessPageProof && pageHasCaseStudyEvidence(page)) {
		return BusinessPageContent
	}
	return role
}

func pageHasExplicitPricingEvidence(page Page) bool {
	return containsBusinessTerm(pageBusinessText(page), []string{
		"pricing plans",
		"subscription plans",
		"compare plans",
		"monthly subscription",
		"annual subscription",
		"choose a package",
		"compare packages",
	})
}

func siteUnderstandingPageValue(page Page) int {
	role := PageBusinessRole(page)
	score := 0
	switch role {
	case BusinessPageHomepage:
		score = 100
	case BusinessPageAbout, BusinessPageOffering, BusinessPagePricing:
		score = 60
	case BusinessPageProof:
		score = 50
	default:
		return -100
	}

	text := pageBusinessText(page)
	if len(strings.Fields(page.MainText)) >= 40 {
		score += 5
	}
	if containsBusinessTerm(text, commercialEvidenceTerms) {
		score += 10
	}
	if pageLooksLikeTutorial(page) {
		score -= 100
	}
	if pageLooksEditorial(page) &&
		!(role == BusinessPageProof && pageHasCaseStudyEvidence(page)) {
		score -= 100
	}
	return score
}

func pageBusinessText(page Page) string {
	return strings.Join([]string{
		page.Title,
		page.Description,
		strings.Join(page.H1, " "),
		strings.Join(page.H2, " "),
		strings.Join(page.H3, " "),
		page.MainText,
	}, " ")
}

func pageLooksLikeErrorShell(page Page) bool {
	text := pageBusinessText(page)
	return len(strings.Fields(text)) <= 80 && containsErrorShellSignal(text)
}

func pageLooksLikeTutorial(page Page) bool {
	text := pageBusinessText(page)
	return containsBusinessTerm(text, tutorialPageTerms) &&
		(containsBusinessTerm(text, tutorialActionTerms) ||
			containsBusinessTerm(text, contentPageTerms))
}

func pageLooksEditorial(page Page) bool {
	if strings.TrimSpace(page.Author) != "" || pageHasSchemaType(page, articleSchemaTypes) {
		return true
	}
	text := pageBusinessText(page)
	return containsBusinessTerm(text, editorialTemplateTerms) ||
		containsBusinessTerm(text, personalReviewTerms)
}

func pageHasCaseStudyEvidence(page Page) bool {
	text := pageBusinessText(page)
	return containsBusinessTerm(text, caseStudyTerms) &&
		containsBusinessTerm(text, commercialOutcomeTerms)
}

func pageHasSchemaType(page Page, wanted map[string]struct{}) bool {
	for _, raw := range page.StructuredData {
		var value any
		if json.Unmarshal(raw, &value) == nil && structuredValueHasType(value, wanted) {
			return true
		}
	}
	return false
}

func structuredValueHasType(value any, wanted map[string]struct{}) bool {
	switch node := value.(type) {
	case []any:
		for _, child := range node {
			if structuredValueHasType(child, wanted) {
				return true
			}
		}
	case map[string]any:
		for _, schemaType := range structuredStrings(node["@type"]) {
			if _, exists := wanted[strings.ToLower(schemaType)]; exists {
				return true
			}
		}
		for _, child := range node {
			if structuredValueHasType(child, wanted) {
				return true
			}
		}
	}
	return false
}

func classifyBusinessPage(pageURL *url.URL, text string) BusinessPageRole {
	if pageURL == nil {
		return BusinessPageOther
	}
	cleanPath := strings.Trim(pageURL.Path, "/")
	if cleanPath == "" {
		return BusinessPageHomepage
	}
	if !strings.Contains(cleanPath, "/") && looksLikeLocalePathSegment(cleanPath) {
		return BusinessPageHomepage
	}
	if isUtilityBusinessPath(cleanPath) {
		return BusinessPageUtility
	}
	if isContentBusinessPath(cleanPath) {
		return BusinessPageContent
	}
	if role := businessRoleFromSignal(cleanPath); role != BusinessPageOther {
		return role
	}
	return businessRoleFromSignal(text)
}

func isContentBusinessPath(cleanPath string) bool {
	for _, segment := range strings.Split(strings.ToLower(strings.Trim(cleanPath, "/")), "/") {
		if containsBusinessTerm(segment, contentPageTerms) {
			return true
		}
	}
	return false
}

func isUtilityBusinessPath(cleanPath string) bool {
	segments := strings.Split(strings.ToLower(strings.Trim(cleanPath, "/")), "/")
	if len(segments) == 0 {
		return false
	}
	if looksLikeLocalePathSegment(segments[0]) && len(segments) > 1 {
		segments = segments[1:]
	}
	if len(segments) == 0 {
		return false
	}
	switch segments[0] {
	case "help", "support", "customer-service", "customer-support", "customer-care",
		"faq", "faqs", "returns", "refunds", "shipping", "delivery", "orders",
		"order-status", "track-order", "accessibility", "login", "signin", "signup",
		"register", "account", "cart", "checkout", "privacy", "terms", "cookies",
		"cookie-policy", "legal", "dmca":
		return true
	default:
		return false
	}
}

func looksLikeLocalePathSegment(segment string) bool {
	parts := strings.Split(strings.ReplaceAll(segment, "_", "-"), "-")
	if len(parts) == 1 {
		return len(parts[0]) == 2 && allASCIIAlpha(parts[0])
	}
	return len(parts) == 2 &&
		len(parts[0]) == 2 && allASCIIAlpha(parts[0]) &&
		len(parts[1]) == 2 && allASCIIAlpha(parts[1])
}

func businessRoleFromSignal(signal string) BusinessPageRole {
	switch {
	case containsBusinessTerm(signal, utilityPageTerms):
		return BusinessPageUtility
	case containsBusinessTerm(signal, pricingPageTerms):
		return BusinessPagePricing
	case containsBusinessTerm(signal, aboutPageTerms):
		return BusinessPageAbout
	case containsBusinessTerm(signal, offeringPageTerms):
		return BusinessPageOffering
	case containsBusinessTerm(signal, proofPageTerms):
		return BusinessPageProof
	case containsBusinessTerm(signal, contactPageTerms):
		return BusinessPageContact
	case containsBusinessTerm(signal, contentPageTerms):
		return BusinessPageContent
	default:
		return BusinessPageOther
	}
}

func containsBusinessTerm(value string, terms []string) bool {
	normalized := strings.ToLower(value)
	normalized = strings.Map(func(r rune) rune {
		switch r {
		case '/', '-', '_', '.', ':', '|', '\t', '\n', '\r':
			return ' '
		default:
			return r
		}
	}, normalized)
	normalized = " " + strings.Join(strings.Fields(normalized), " ") + " "
	for _, term := range terms {
		term = strings.ToLower(strings.TrimSpace(term))
		if term == "" {
			continue
		}
		if containsNonASCII(term) && strings.Contains(normalized, term) {
			return true
		}
		if strings.Contains(normalized, " "+term+" ") {
			return true
		}
	}
	return false
}

func containsNonASCII(value string) bool {
	for _, char := range value {
		if char > 127 {
			return true
		}
	}
	return false
}

var aboutPageTerms = []string{
	"about", "company", "mission", "our mission", "story", "our story", "who we are",
	"关于", "关于我们", "公司", "我们的使命",
	"sobre nosotros", "quienes somos", "nuestra empresa",
	"à propos", "notre entreprise", "qui sommes nous",
	"über uns", "unternehmen", "wer wir sind",
	"sobre nós", "quem somos", "empresa",
	"会社概要", "私たちについて", "회사 소개",
}

var offeringPageTerms = []string{
	"product", "products", "service", "services", "solution", "solutions",
	"platform", "feature", "features", "capability", "capabilities",
	"category", "categories", "collection", "collections", "catalog", "shop",
	"store", "menu", "download", "downloads",
	"产品", "服务", "解决方案", "功能", "平台",
	"producto", "productos", "servicio", "servicios", "soluciones",
	"produit", "produits", "service", "services", "solutions", "fonctionnalités",
	"produkt", "produkte", "dienstleistung", "dienstleistungen", "lösungen",
	"produto", "produtos", "serviço", "serviços", "soluções",
	"製品", "サービス", "ソリューション", "機能",
	"제품", "서비스", "솔루션", "기능",
}

var pricingPageTerms = []string{
	"pricing", "price", "prices", "package", "packages",
	"pricing plan", "pricing plans", "subscription plan", "subscription plans",
	"compare plans", "choose a plan",
	"定价", "价格", "套餐",
	"precio", "precios", "tarifa", "tarifas",
	"tarif", "tarifs", "tarification",
	"preis", "preise", "preisliste",
	"preço", "preços",
	"料金", "価格", "요금", "가격",
}

var proofPageTerms = []string{
	"customer", "customers", "client", "clients", "case study", "case studies",
	"industry", "industries", "portfolio", "success story", "success stories",
	"客户", "客户案例", "案例", "成功案例",
	"cliente", "clientes", "caso de éxito", "casos de éxito",
	"client", "clients", "étude de cas", "études de cas",
	"kunde", "kunden", "fallstudie", "fallstudien",
	"cliente", "clientes", "caso de sucesso", "casos de sucesso",
	"導入事例", "お客様", "고객", "사례",
}

var contactPageTerms = []string{
	"contact", "locations", "location", "get in touch",
	"联系", "联系我们", "联系方式",
	"contacto", "contáctenos",
	"contactez nous", "kontakt", "kontaktieren", "contato",
	"お問い合わせ", "連絡先", "문의", "연락처",
}

var contentPageTerms = []string{
	"blog", "blogs", "article", "articles", "news", "press", "resource",
	"resources", "guide", "guides", "insight", "insights", "academy",
	"博客", "文章", "新闻", "资源", "指南",
	"noticias", "recursos", "guías",
	"actualités", "ressources", "guides",
	"nachrichten", "ressourcen", "leitfäden",
	"notícias", "recursos", "guias",
	"ブログ", "ニュース", "リソース", "ガイド",
	"블로그", "뉴스", "자료", "가이드",
}

var utilityPageTerms = []string{
	"login", "signin", "sign in", "signup", "sign up", "register", "cart",
	"checkout", "account", "privacy", "terms", "cookie", "cookies", "tag",
	"author", "feed", "search", "legal", "dmca",
	"登录", "注册", "购物车", "结账", "账户", "隐私", "条款", "搜索",
	"iniciar sesión", "registrarse", "carrito", "privacidad", "términos",
	"connexion", "inscription", "panier", "confidentialité", "conditions",
	"anmelden", "registrieren", "warenkorb", "datenschutz",
	"entrar", "cadastro", "carrinho", "privacidade", "termos",
	"ログイン", "登録", "カート", "プライバシー", "利用規約",
	"로그인", "가입", "장바구니", "개인정보", "이용약관",
}

var articleSchemaTypes = map[string]struct{}{
	"article": {}, "blogposting": {}, "newsarticle": {}, "review": {},
}

var tutorialPageTerms = []string{
	"how to", "step by step", "step-by-step", "installation guide", "setup guide",
	"instructions", "tutorial", "troubleshooting", "getting started",
	"操作指南", "安装指南", "分步指南", "教程", "故障排查",
}

var tutorialActionTerms = []string{
	"step 1", "step 2", "download and install", "how do i", "follow these steps",
	"第 1 步", "第一步", "第二步", "下载并安装",
}

var editorialTemplateTerms = []string{
	"recent posts", "related posts", "leave a comment", "comments", "published by",
	"written by", "reading time", "share this article",
	"近期文章", "相关文章", "发表评论", "阅读时间",
}

var personalReviewTerms = []string{
	"my review", "my experience", "why i switched", "why i chose", "i tried",
	"i tested", "my story", "我的体验", "我的评价", "我为什么选择",
}

var caseStudyTerms = []string{
	"case study", "customer story", "customer success", "success story",
	"client story", "客户案例", "客户故事", "成功案例",
}

var commercialOutcomeTerms = []string{
	"increased", "reduced", "improved", "saved", "grew", "growth", "faster",
	"revenue", "conversion", "productivity", "efficiency", "return on investment",
	"roi", "提升", "降低", "节省", "增长", "效率", "收入", "转化率",
}

var commercialEvidenceTerms = []string{
	"product", "service", "software", "platform", "solution", "application", "app",
	"subscription", "pricing", "package", "customer", "client", "book a demo",
	"get a quote", "buy now", "sign up", "产品", "服务", "软件", "平台", "解决方案",
	"应用", "订阅", "价格", "套餐", "客户", "购买", "预约演示",
}
