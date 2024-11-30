import {z} from 'zod'

export interface BaseTemplateProps {
    company_name: string,
    company_url: string,
    company_address: string,
    company_copyright: string,
    support_email: string,
    [key: string]: string,
}

export const baseTemplatePropsSchema = z.object({
    company_name: z.string(),
    company_url: z.string(),
    company_address: z.string(),
    company_copyright: z.string(),
    support_email: z.string(),
})
