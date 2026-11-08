import { z } from 'zod';

export const orderSchema = z.object({
  eventId: z.string().trim().min(1).max(200),
  orderId: z.string().trim().min(1).max(200),
  currency: z.string().regex(/^[A-Z]{3}$/),
  amountCents: z.number().int().nonnegative().max(100_000_000_00),
  items: z.array(z.object({
    sku: z.string().trim().min(1).max(100),
    quantity: z.number().int().positive().max(10_000),
  }).strict()).min(1).max(500),
}).strict();

export type OrderEvent = z.infer<typeof orderSchema>;
