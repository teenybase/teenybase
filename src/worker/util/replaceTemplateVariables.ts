export function replaceTemplateVariables(html: string, variables: Record<string, string|number|boolean>, times = 1) {
    // format = {{name | default}}
    if(!html || !times) return html
    let res = html.replace(/\{\{(.*?)}}/g, (match, p1) => {
        const split = (p1 as string).split('|')
        const key = split[0]?.trim() || ''
        const def = split.slice(1).join('|').trim() || ''
        return (variables[key] || def) + ''
    })
    if(times > 1 && res.search(/\{\{(.*?)}}/)) res = replaceTemplateVariables(res, variables, times-1)
    return res
}
