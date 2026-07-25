export const DEFAULT_GATEWAY_HOST = "127.0.0.1";

export function parseGatewayHost(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.length > 253 ||
    !/^[a-z0-9_.:%-]+$/i.test(value)
  ) {
    throw new Error(`${label} must be a valid bind host`);
  }
  return value;
}

export function parseGatewayDomain(value: string, label: string): string {
  const domain = value.toLowerCase();
  if (domain.length === 0 || domain.length > 253) {
    throw new Error(`${label} must be a valid DNS domain`);
  }
  const labels = domain.split(".");
  if (labels.some((part) => !isDnsLabel(part))) {
    throw new Error(`${label} must be a valid DNS domain`);
  }
  return domain;
}

function isDnsLabel(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)
  );
}
