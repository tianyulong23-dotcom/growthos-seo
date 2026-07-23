export type AuditScope = "domain" | "subdomains" | "directory"
export type AuditRendering = "auto" | "off" | "all"

export type AuditSettings = {
  maxPages: number
  scope: AuditScope
  rendering: AuditRendering
  directory: string
  allowedPaths: string[]
  excludedPaths: string[]
  ignoredParameters: string[]
  issueExclusionPatterns: string[]
  enableDuplicationCheck: boolean
  duplicationThreshold: number
  enablePageSpeed: boolean
}

export const defaultIgnoredParameters = [
  "utm_*",
  "gclid",
  "fbclid",
  "msclkid",
  "yclid",
]

export const defaultIssueExclusionPatterns = `
/wp-admin/*
/wp-content/plugins/*
/wp-content/themes/*
/wp-content/uploads/*
/wp-includes/*
/wp-login.php
/wp-cron.php
/xmlrpc.php
/wp-json/*
/wp-activate.php
/wp-signup.php
/wp-trackback.php
/login*
/signin*
/sign-in*
/log-in*
/auth/*
/authenticate/*
/register*
/signup*
/sign-up*
/registration/*
/logout*
/signout*
/sign-out*
/log-out*
/forgot-password*
/reset-password*
/password-reset*
/recover-password*
/change-password*
/account/password/*
/user/password/*
/activate/*
/verification/*
/verify/*
/confirm/*
/admin/*
/administrator/*
/_admin/*
/backend/*
/dashboard/*
/cpanel/*
/phpmyadmin/*
/pma/*
/webmail/*
/plesk/*
/control-panel/*
/manage/*
/manager/*
/checkout/*
/cart/*
/basket/*
/payment/*
/billing/*
/order/*
/orders/*
/purchase/*
/account/*
/profile/*
/settings/*
/preferences/*
/my-account/*
/user/*
/member/*
/members/*
/cgi-bin/*
/cgi/*
/fcgi-bin/*
/.git/*
/.svn/*
/.hg/*
/.bzr/*
/.cvs/*
/.env
/.env.*
/.htaccess
/.htpasswd
/web.config
/app.config
/composer.json
/package.json
/node_modules/*
/vendor/*
/bower_components/*
/jspm_packages/*
/includes/*
/lib/*
/libs/*
/src/*
/dist/*
/build/*
/builds/*
/_next/*
/.next/*
/out/*
/_nuxt/*
/.nuxt/*
/test/*
/tests/*
/spec/*
/specs/*
/__tests__/*
/debug/*
/dev/*
/development/*
/staging/*
/api/internal/*
/api/admin/*
/api/private/*
/private/*
/system/*
/core/*
/internal/*
/tmp/*
/temp/*
/cache/*
/logs/*
/log/*
/backup/*
/backups/*
/old/*
/archive/*
/archives/*
/config/*
/configs/*
/configuration/*
/upload/*
/uploads/*
/uploader/*
/file-upload/*
/search*
*/search/*
?s=*
?search=*
*/filter/*
?filter=*
*/sort/*
?sort=*
/print/*
?print=*
/preview/*
?preview=*
/embed/*
?embed=*
/amp/*
/amp
/feed/*
/feeds/*
/rss/*
*.rss
/atom/*
*.atom
*.json
*.xml
*.yaml
*.yml
*.toml
*.ini
*.conf
*.log
*.txt
*.csv
*.sql
*.db
*.bak
*.backup
*.old
*.orig
*.tmp
*.swp
*.map
*.min.js
*.min.css
`
  .trim()
  .split("\n")

export const defaultAuditSettings: AuditSettings = {
  maxPages: 1000,
  scope: "domain",
  rendering: "auto",
  directory: "",
  allowedPaths: [],
  excludedPaths: [],
  ignoredParameters: defaultIgnoredParameters,
  issueExclusionPatterns: defaultIssueExclusionPatterns,
  enableDuplicationCheck: true,
  duplicationThreshold: 0.85,
  enablePageSpeed: false,
}
