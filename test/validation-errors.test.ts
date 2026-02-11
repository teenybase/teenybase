import {describe, expect, it} from 'vitest'
import {zCustomError, formatZodError, throw zCustomError, validateSettingsChange} from '../src'
import {z} from 'zod'

describe('Validation Error Handling', () => {
    it('should create a ZodError with structured path', () => {
        const error = zCustomError('Test error message', ['settings', 'tables', 'users', 'fields', 'email'])

        expect(error).toBeInstanceOf(z.ZodError)
        expect(error.issues).toHaveLength(1)
        expect(error.issues[0].code).toBe('custom')
        expect(error.issues[0].message).toBe('Test error message')
        expect(error.issues[0].path).toEqual(['settings', 'tables', 'users', 'fields', 'email'])
    })

    it('should throw a validation error', () => {
        expect(() => {
            throw zCustomError('Field is required', 'table', 'users', 'fields', 'name')
        }).toThrow(z.ZodError)
    })

    it('should format validation errors with path', () => {
        const error = zCustomError('Field type is invalid', ['table', 'posts', 'fields', 'author_id', 'type'])
        const formatted = formatZodError(error, 'Validation failed')

        expect(formatted).toContain('Validation failed')
        expect(formatted).toContain('table → posts → fields → author_id → type')
        expect(formatted).toContain('Field type is invalid')
    })

    it('should format multiple validation errors', () => {
        const error = new z.ZodError([
            {
                code: 'custom',
                message: 'Field name is required',
                path: ['table', 'users', 'fields', 0, 'name']
            },
            {
                code: 'custom',
                message: 'Field type is invalid',
                path: ['table', 'users', 'fields', 1, 'type']
            }
        ])

        const formatted = formatZodError(error)

        expect(formatted).toContain('table → users → fields → 0 → name')
        expect(formatted).toContain('Field name is required')
        expect(formatted).toContain('table → users → fields → 1 → type')
        expect(formatted).toContain('Field type is invalid')
    })
})

describe('validateSettingsChange errors test', () => {
    // the script should be run from root dir(with package.json)
    it('empty settings', async ()=>{
        try {
            validateSettingsChange({} as any, undefined)
        } catch (e){
            expect(e).toBeInstanceOf(z.ZodError)
            const ze = e as z.ZodError
            expect(ze.issues).toEqual([
                {
                    "expected": "array",
                    "code": "invalid_type",
                    "path": [
                        "settings",
                        "tables"
                    ],
                    "message": "Invalid input: expected array, received undefined"
                },
                {
                    "expected": "string",
                    "code": "invalid_type",
                    "path": [
                        "settings",
                        "jwtSecret"
                    ],
                    "message": "Invalid input: expected string, received undefined"
                },
                {
                    "expected": "string",
                    "code": "invalid_type",
                    "path": [
                        "settings",
                        "appUrl"
                    ],
                    "message": "Invalid input: expected string, received undefined"
                }
            ])
        }
    })

    // todo test other errors
})
