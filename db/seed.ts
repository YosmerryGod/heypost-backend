import { getDb } from "../api/queries/connection";
import { categories, products, transactionItems, transactions } from "./schema";

const image = (id: string) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=480&q=82`;

const catalog = [
  ["Kopi & Minuman", [
    ["Kopi Susu Hey", 24000, 38, "photo-1509042239860-f550ce710b93"],
    ["Es Americano", 22000, 24, "photo-1497935586351-b67a49e012bf"],
    ["Matcha Latte", 28000, 16, "photo-1515823064-d6e0c04616a7"],
    ["Cokelat Klasik", 26000, 20, "photo-1542990253-a781e04c0082"],
    ["Teh Leci Segar", 22000, 31, "photo-1556679343-c7306c1976bc"],
  ]],
  ["Makanan", [
    ["Nasi Ayam Sambal Matah", 38000, 19, "photo-1512058564366-18510be2db19"],
    ["Mie Goreng Spesial", 32000, 22, "photo-1569718212165-3a8278d5f624"],
    ["Rice Bowl Teriyaki", 36000, 14, "photo-1546069901-ba9599a7e63c"],
    ["Kentang Goreng", 22000, 27, "photo-1573080496219-bb080dd4f877"],
  ]],
  ["Roti & Pastry", [
    ["Butter Croissant", 24000, 12, "photo-1555507036-ab1f4038808a"],
    ["Roti Bakar Cokelat", 20000, 15, "photo-1528735602780-2552fd46c7af"],
    ["Pain au Chocolat", 26000, 8, "photo-1509440159596-0249088772ff"],
  ]],
  ["Pencuci Mulut", [
    ["Choco Slice Cake", 30000, 9, "photo-1578985545062-69928b1d9587"],
    ["Cheesecake Berry", 34000, 7, "photo-1533134242443-d4fd215305ad"],
    ["Pudding Karamel", 20000, 11, "photo-1551024506-0bccd828d307"],
  ]],
] as const;

export async function seedIfEmpty() {
  const db = getDb();
  const existingCategories = db.select().from(categories).limit(1).all();
  if (existingCategories.length > 0) return;

  let sku = 1001;
  db.transaction((tx) => {
    for (const [categoryIndex, [categoryName, rows]] of catalog.entries()) {
      const [{ id: categoryId }] = tx.insert(categories).values({ name: categoryName, sortOrder: categoryIndex }).returning({ id: categories.id }).all();
      tx.insert(products).values(rows.map(([name, price, stock, photo]) => ({
        categoryId,
        name,
        price,
        stock,
        imageUrl: image(photo),
        sku: `HP-${sku++}`,
      }))).run();
    }

    const allProducts = tx.select().from(products).limit(5).all();
    if (allProducts.length === 0) return;
    const now = Date.now();
    for (let day = 6; day >= 0; day--) {
      const product = allProducts[(6 - day) % allProducts.length];
      const quantity = (day % 3) + 1;
      const total = product.price * quantity;
      const createdAt = new Date(now - day * 86400000 - (day % 4) * 3600000);
      const [{ id: transactionId }] = tx.insert(transactions).values({
        invoiceNumber: `HP-DEMO-${day}-${product.id}`,
        customerName: day % 2 ? "Pelanggan toko" : "Rani",
        orderType: day % 2 ? "Bawa pulang" : "Makan di tempat",
        paymentMethod: day % 3 ? "QRIS" : "Tunai",
        subtotal: total,
        total,
        cashReceived: day % 3 ? null : total,
        createdAt,
      }).returning({ id: transactions.id }).all();
      tx.insert(transactionItems).values({
        transactionId,
        productId: product.id,
        productName: product.name,
        unitPrice: product.price,
        quantity,
        subtotal: total,
      }).run();
    }
  });
}
