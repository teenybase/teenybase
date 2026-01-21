import {z} from 'zod';

export const issuerConfigSchema = z.object({
    issuer: z.string(),
    secret: z.string().optional(),
    algorithm: z.string().optional(),
    clientId: z.string().optional(),
});

export const allowedIssuerSchema = z.union([
    z.string(),
    issuerConfigSchema,
]);

