export function shortenHash(value: string, head = 6, tail = 4): string {
  if (!value) return '';
  if (value.length <= head + tail + 2) return value;
  return `${value.slice(0, head + 2)}…${value.slice(-tail)}`;
}

export function formatNumber(value: string | number): string {
  const num = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(num)) return String(value);
  return new Intl.NumberFormat('en-US').format(num);
}

export function formatWeiToQfc(value: string): string {
  if (!value) return '0';
  try {
    let wei: bigint;
    if (value.startsWith('0x') || value.startsWith('0X')) {
      wei = BigInt(value);
    } else if (/^[0-9]+$/.test(value)) {
      wei = BigInt(value);
    } else if (/^[0-9a-fA-F]+$/.test(value)) {
      wei = BigInt('0x' + value);
    } else {
      wei = BigInt(value);
    }

    const base = 10n ** 18n;
    const whole = wei / base;
    const fraction = wei % base;
    const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (fraction === 0n) return wholeStr;
    const fractionStr = fraction.toString().padStart(18, '0').slice(0, 4);
    return `${wholeStr}.${fractionStr}`;
  } catch {
    return value;
  }
}
