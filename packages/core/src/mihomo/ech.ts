const STANDARD_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DNS_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export interface MihomoEchOpts {
  enable: true;
  config?: string;
  "query-server-name"?: string;
}

export function isStandardBase64String(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length % 4 === 0 && STANDARD_BASE64_PATTERN.test(trimmed);
}

export function isMihomoEchQueryServerName(value: string): boolean {
  const trimmed = value.trim();
  const hostname = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  if (!hostname || hostname.length > 253 || !hostname.includes(".") || !/[A-Za-z]/.test(hostname)) return false;

  return hostname.split(".").every((label) => label.length <= 63 && DNS_LABEL_PATTERN.test(label));
}

function hasAbsoluteResolverUri(value: string): boolean {
  const schemeEnd = value.indexOf("://");
  if (schemeEnd <= 0) return false;

  const firstCode = value.charCodeAt(0);
  const firstIsAlpha =
    (firstCode >= 65 && firstCode <= 90) || (firstCode >= 97 && firstCode <= 122);
  if (!firstIsAlpha) return false;

  for (let index = 1; index < schemeEnd; index += 1) {
    const code = value.charCodeAt(index);
    const isAlpha = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const isDigit = code >= 48 && code <= 57;
    if (!isAlpha && !isDigit && code !== 43 && code !== 45 && code !== 46) return false;
  }

  const authorityStart = schemeEnd + 3;
  if (authorityStart >= value.length) return false;
  let authorityEnd = value.length;
  for (let index = authorityStart; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 32 || code === 127) return false;
    if (authorityEnd === value.length && (code === 47 || code === 63 || code === 35)) {
      authorityEnd = index;
    }
  }
  if (authorityEnd <= authorityStart) return false;

  try {
    return Boolean(new URL(`https://${value.slice(authorityStart)}`).hostname);
  } catch {
    return false;
  }
}

export function buildMihomoEchOptsFromShareValue(value: unknown): MihomoEchOpts {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return { enable: true };
  if (isStandardBase64String(normalized)) return { enable: true, config: normalized };
  if (isMihomoEchQueryServerName(normalized)) {
    return { enable: true, "query-server-name": normalized };
  }
  const separatorIndex = normalized.indexOf("+");
  if (separatorIndex > 0) {
    const queryServerName = normalized.slice(0, separatorIndex).trim();
    const resolverUri = normalized.slice(separatorIndex + 1).trim();
    if (isMihomoEchQueryServerName(queryServerName) && hasAbsoluteResolverUri(resolverUri)) {
      return { enable: true, "query-server-name": queryServerName };
    }
  }
  return { enable: true };
}
