/** Converts a local number such as 0803 123 4567 to 2348031234567 (for WhatsApp / SMS links). */
export function toInternational(phone: string, countryCode: string) {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.startsWith('0')) return countryCode + digits.slice(1);
  if (digits.startsWith(countryCode)) return digits;
  return countryCode + digits;
}

export const whatsappLink = (phone: string, countryCode: string, text: string) =>
  `https://wa.me/${toInternational(phone, countryCode)}?text=${encodeURIComponent(text)}`;
