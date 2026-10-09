// Um único ponto decide o criador; o payload nunca escolhe uma conta arbitrária.
export class AttributionPolicy {
  constructor({
    coupons = { ANA10: 'creator-ana', BRUNO10: 'creator-bruno' },
    utmContent = { ana: 'creator-ana', bruno: 'creator-bruno', 'creator-ana': 'creator-ana', 'creator-bruno': 'creator-bruno' },
  } = {}) {
    this.coupons = new Map(Object.entries(coupons).map(([key, creator]) => [key.trim().toUpperCase(), creator]));
    this.utmContent = new Map(Object.entries(utmContent).map(([key, creator]) => [key.trim().toLowerCase(), creator]));
  }

  decide({ coupon, utms }) {
    const coupon_candidate = this.coupons.get(coupon) ?? null;
    const utm_candidate = this.utmContent.get(utms.utm_content?.toLowerCase()) ?? null;
    if (coupon_candidate) return {
      creator_id: coupon_candidate,
      rule: 'coupon',
      coupon_candidate,
      utm_candidate,
      reason: utm_candidate && utm_candidate !== coupon_candidate
        ? 'Cupom reconhecido prevalece sobre UTM de outro criador.'
        : 'Cupom reconhecido é o vínculo de atribuição prioritário.',
    };
    if (utm_candidate) return {
      creator_id: utm_candidate,
      rule: 'utm_content',
      coupon_candidate,
      utm_candidate,
      reason: 'Sem cupom reconhecido; utm_content identifica um criador cadastrado.',
    };
    return {
      creator_id: null,
      rule: 'organic',
      coupon_candidate,
      utm_candidate,
      reason: 'Nenhum cupom ou utm_content corresponde a um criador cadastrado.',
    };
  }
}
