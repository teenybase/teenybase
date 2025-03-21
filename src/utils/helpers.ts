
export function pathJoin(parts: string[], sep?: string): string {
    const separator = sep || '/';
    const replace   = new RegExp(separator+'{1,}', 'g');
    return parts.join(separator).replace(replace, separator);
}
