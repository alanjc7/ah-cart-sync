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
  tofu: {productId: 598995, title: "AH Terra Biologische tofu grootverpakking"},
  pastry: {productId: 503093, title: "AH Vers bladerdeeg"},
  garlic: {productId: 185774, title: "AH Biologisch Knoflook"},
  cucumber: {productId: 101130, title: "AH Biologisch Komkommer"},
  carrots: {productId: 561136, title: "AH Biologisch Winterpeen"},
  pesto: {productId: 30037, title: "Bertolli Pesto alla genovese"},
  "tricolour pasta": {productId: 519105, title: "Grand' Italia Fusilli tricolori"},
  "brown onions": {productId: 4083, title: "AH Gele uien"},
  "red onions": {productId: 439146, title: "AH Rode uien"},
  "chopped tomatoes": {productId: 395307, title: "AH Biologisch Tomatenblokjes"},
  "pizza sauce": {productId: 234871, title: "Mutti Pizzasaus aromatica"},
  "grated cheese": {productId: 478232, title: "AH Tex-mex geraspte kaas"},
  "cheese slices": {productId: 185784, title: "AH Biologisch Jong belegen 50+ plakken"},
  "peanut butter": { productId: 479791, title: "AH Terra Plantaardig 100% pindakaas naturel" },
  "sour cream": {productId: 585958, title: "AH Biologisch Sour cream"},
  "shoarma": {productId: 563706, title: "AH Terra Plantaardige shoarma"},
  "frozen mango": {productId: 445512, title: "AH Zakje met mangostukjes"},
  "frozen banana": {productId: 582336, title: "AH Zakje met banaan plakjes"},
  "frozen raspberries": {productId: 513739, title: "AH Zakje met frambozen"},
  "toilet roll": {productId: 595095, title: "AH Eco Toiletpapier 3-laags 8=12 rollen"},
  "toilet paper": {productId: 595095, title: "AH Eco Toiletpapier 3-laags 8=12 rollen"},
  "dishwasher tablets": {productId: 232662, title: "AH Power all in 1 vaatwastabletten"},
  "dishwasher tabs": {productId: 232662, title: "AH Power all in 1 vaatwastabletten"},
};
