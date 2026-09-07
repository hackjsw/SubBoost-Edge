export const KV_TTL = 604800;
export const SUBCONVERTER_BACKEND = "https://api.wcc.best/sub";
export const ACL4SSR_CONFIG_URL =
  "https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config/ACL4SSR_Online.ini";

export const REGION_CONFIG: Record<string, string[]> = {
  "HK Hong Kong": ["HK", "HongKong", "Hong Kong", "香港", "HKG"],
  "TW Taiwan": ["TW", "Taiwan", "Taipei", "台湾", "CN_TW", "TWN"],
  "SG Singapore": ["SG", "Singapore", "狮城", "新加坡", "SGP"],
  "JP Japan": ["JP", "Japan", "Tokyo", "Osaka", "日本", "JPN"],
  "US United States": ["US", "USA", "America", "United States", "LosAngeles", "SanJose", "美国"],
  "KR Korea": ["KR", "Korea", "Seoul", "韩国"],
  "DE Germany": ["DE", "Germany", "Frankfurt", "德国"],
  "FR France": ["FR", "France", "Paris", "法国"],
  "UK United Kingdom": ["UK", "Britain", "England", "London", "英国"],
  "CA Canada": ["CA", "Canada", "加拿大"],
  "RU Russia": ["RU", "Russia", "俄罗斯"],
  Global: ["Anycast", "Global", "IP-"],
  Preferred: ["优选", "Cloudflare", "CF", "CDN", "shopify", "ubi", "sin.fan"],
};

export const CF_NON_TLS_PORTS = new Set(["80", "8080", "8880", "2052", "2082", "2086", "2095"]);
export const TLS_PORTS = new Set(["443", "8443", "2053", "2083", "2087", "2096"]);

export const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_STORED_YAML_BYTES = 8 * 1024 * 1024;
export const MAX_STORED_SUBSCRIPTION_BYTES = 20 * 1024 * 1024;
export const MAX_SOURCE_ITEMS = 1000;
export const MAX_REMOTE_SOURCES = 32;
export const MAX_REMOTE_REQUESTS_PER_REFRESH = 40;
export const MAX_TEST_NODES = 64;
export const MAX_MANAGED_SUBSCRIPTION_NODES = 10000;
export const MIN_AUTO_UPDATE_INTERVAL_SECONDS = 60 * 60;
