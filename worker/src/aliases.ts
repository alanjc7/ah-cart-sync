// Item-name -> exact product mapping, checked before falling back to search.
// Keys are matched case-insensitively after trimming.
//
// To find a webshopId: open the product on ah.nl or in the app; the URL has
// a "wi<number>" segment (e.g. ah.nl/producten/product/wi123456/...) — drop
// the "wi" prefix, the API wants the plain number.
export const ALIASES: Record<string, { productId: number; title: string }> = {
  hummus: { productId: 486453, title: "Maza Hoemoes XL" },
  milk: { productId: 382907, title: "AH Biologisch Halfvolle melk 1,5L" },
  peppers: { productId: 41194, title: "AH Paprika mix" },
  bananas: { productId: 368480, title: "AH Biologisch Fairtrade bananen" },
  wraps: { productId: 173410, title: "AH Tortilla naturel wraps large 12 stuks" },
  yoghurt: { productId: 60746, title: "AH Biologisch Volle yoghurt" },
  "peanut butter": { productId: 479791, title: "AH Terra Plantaardig 100% pindakaas naturel" },
  "sour cream": {productId: 585958, title: "AH Biologisch Sour cream"},
  "shoarma": {productId: 563706, title: "AH Terra Plantaardige shoarma"},
  "tofu": {productId: 598995, title: "AH Terra Biologische tofu grootverpakking"},
  "pastry": {productId: 503093, title: "AH Vers bladerdeeg"},
  "garlic": {productId: 185774, title: "AH Biologisch Knoflook"},
};
