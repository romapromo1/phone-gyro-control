const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const VIRTUAL_INTERFACE_PATTERN = /vpn|tun|tap|tailscale|wireguard|amnezia|wsl|hyper-v|vethernet|docker|vmware|virtualbox|loopback/i;
const PHYSICAL_INTERFACE_PATTERN = /wi-?fi|wireless|wlan|ethernet|беспровод|локальн/i;

export function selectLanIpv4(networkInterfaces, preferredAddress = '') {
  const preferred = normalizeIpv4(preferredAddress);
  if (preferred && preferred !== '127.0.0.1') return preferred;

  const candidates = [];
  for (const [name, addresses] of Object.entries(networkInterfaces || {})) {
    for (const address of addresses || []) {
      const ipv4 = address?.family === 'IPv4' ? normalizeIpv4(address.address) : null;
      if (!ipv4 || address.internal || ipv4 === '127.0.0.1') continue;
      candidates.push({
        address: ipv4,
        score: scoreAddress(name, address),
      });
    }
  }

  candidates.sort((left, right) => right.score - left.score || left.address.localeCompare(right.address));
  return candidates[0]?.address || '127.0.0.1';
}

function scoreAddress(interfaceName, address) {
  let score = 0;
  if (isPrivateLanAddress(address.address)) score += 300;
  if (address.address.startsWith('192.168.')) score += 40;
  if (PHYSICAL_INTERFACE_PATTERN.test(interfaceName)) score += 180;
  if (VIRTUAL_INTERFACE_PATTERN.test(interfaceName)) score -= 260;
  if (address.mac && address.mac !== '00:00:00:00:00:00') score += 30;

  const prefixLength = getPrefixLength(address.cidr, address.netmask);
  if (prefixLength >= 30) score -= 260;
  else if (prefixLength >= 16 && prefixLength <= 29) score += 40;

  return score;
}

function isPrivateLanAddress(value) {
  const octets = value.split('.').map(Number);
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function getPrefixLength(cidr, netmask) {
  const cidrPrefix = Number(String(cidr || '').split('/')[1]);
  if (Number.isInteger(cidrPrefix) && cidrPrefix >= 0 && cidrPrefix <= 32) return cidrPrefix;
  const normalizedMask = normalizeIpv4(netmask);
  if (!normalizedMask) return 32;
  return normalizedMask
    .split('.')
    .map(Number)
    .reduce((total, octet) => total + octet.toString(2).replace(/0/g, '').length, 0);
}

function normalizeIpv4(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(IPV4_PATTERN);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return null;
  return octets.join('.');
}
