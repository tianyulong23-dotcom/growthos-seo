export type ProjectOption = {
  value: string
  label: string
  code: string
  searchText: string
  sortLabel: string
  isCommon: boolean
}

const countryCodes = `
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ
DE DJ DK DM DO DZ
EC EE EG EH ER ES ET
FI FJ FK FM FO FR
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
HK HM HN HR HT HU
ID IE IL IM IN IO IQ IR IS IT
JE JM JO JP
KE KG KH KI KM KN KP KR KW KY KZ
LA LB LC LI LK LR LS LT LU LV LY
MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
NA NC NE NF NG NI NL NO NP NR NU NZ
OM
PA PE PF PG PH PK PL PM PN PR PS PT PW PY
QA
RE RO RS RU RW
SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ
UA UG UM US UY UZ
VA VC VE VG VI VN VU
WF WS
YE YT
ZA ZM ZW
`
  .trim()
  .split(/\s+/)

const languageCodes = `
en zh-Hans zh-Hant es es-419 de fr pt pt-BR pt-PT ja ko it nl ru ar hi id tr vi th pl
sv da no fi cs hu ro uk el he fa ur bn ms fil sw ta te mr gu kn ml
pa ne si km lo my mn ka hy az kk uz tk ky tg sq bs hr sr sl sk bg
mk et lv lt is ga cy eu ca gl af zu xh am so
`
  .trim()
  .split(/\s+/)

const commonCountryCodes = [
  "US",
  "GB",
  "DE",
  "BR",
  "FR",
  "ES",
  "CN",
  "RU",
  "JP",
  "IN",
  "SE",
]

const commonLanguageCodes = [
  "en",
  "de",
  "fr",
  "es",
  "es-419",
  "zh-Hans",
  "zh-Hant",
  "ru",
  "ar",
  "pt-BR",
  "pt-PT",
  "sv",
  "ja",
]

const languageLabelOverrides: Record<string, string> = {
  "zh-Hans": "简体中文",
  "zh-Hant": "繁体中文",
  "es-419": "西班牙语（拉丁美洲）",
  "pt-BR": "葡萄牙语（巴西）",
  "pt-PT": "葡萄牙语（葡萄牙）",
}

const chineseRegionNames = new Intl.DisplayNames(["zh-CN"], { type: "region" })
const englishRegionNames = new Intl.DisplayNames(["en"], { type: "region" })
const chineseLanguageNames = new Intl.DisplayNames(["zh-CN"], {
  type: "language",
})
const englishLanguageNames = new Intl.DisplayNames(["en"], {
  type: "language",
})
const englishCollator = new Intl.Collator("en", { sensitivity: "base" })

function sortOptions(options: ProjectOption[], commonCodes: string[]) {
  const commonOrder = new Map(commonCodes.map((code, index) => [code, index]))

  return options.sort((left, right) => {
    if (left.isCommon && right.isCommon) {
      return (
        (commonOrder.get(left.code) ?? 0) - (commonOrder.get(right.code) ?? 0)
      )
    }
    if (left.isCommon !== right.isCommon) {
      return left.isCommon ? -1 : 1
    }
    return englishCollator.compare(left.sortLabel, right.sortLabel)
  })
}

export const projectCountryOptions = sortOptions(
  countryCodes.map((code) => {
    const label = chineseRegionNames.of(code) ?? code
    const englishLabel = englishRegionNames.of(code) ?? code

    return {
      value: code,
      label,
      code,
      searchText: `${label} ${englishLabel} ${code}`,
      sortLabel: englishLabel,
      isCommon: commonCountryCodes.includes(code),
    }
  }),
  commonCountryCodes
)

export const projectLanguageOptions = sortOptions(
  languageCodes.map((code) => {
    const label =
      languageLabelOverrides[code] ?? chineseLanguageNames.of(code) ?? code
    const englishLabel = englishLanguageNames.of(code) ?? code

    return {
      value: code,
      label,
      code,
      searchText: `${label} ${englishLabel} ${code}`,
      sortLabel: englishLabel,
      isCommon: commonLanguageCodes.includes(code),
    }
  }),
  commonLanguageCodes
)

function resolveOption(options: ProjectOption[], value: string) {
  const normalized = value.trim().toLocaleLowerCase()
  return options.find(
    (option) =>
      option.value.toLocaleLowerCase() === normalized ||
      option.label.toLocaleLowerCase() === normalized ||
      option.sortLabel.toLocaleLowerCase() === normalized
  )
}

export function formatProjectMarket(country: string, language: string) {
  const countryOption = resolveOption(projectCountryOptions, country)
  const languageOption = resolveOption(projectLanguageOptions, language)
  const countryLabel = countryOption
    ? (englishRegionNames.of(countryOption.code) ?? countryOption.code)
    : country
  const languageLabel = languageOption
    ? (englishLanguageNames.of(languageOption.code) ?? languageOption.code)
    : language
  return `${countryLabel} · ${languageLabel}`
}
