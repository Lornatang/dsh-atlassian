export function decodeToolJson(content) {
    const blocks = Array.isArray(content) ? content : [];
    const raw = blocks.map((entry) => {
        const text = entry && typeof entry === 'object' ? entry['text'] : undefined;
        return typeof text === 'string' ? text : '';
    }).join('\n').trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '');
    return JSON.parse(raw);
}
export function selectJiraResource(data, allowsHttp) {
    for (const item of Array.isArray(data) ? data : [data]) {
        if (!item || typeof item !== 'object')
            continue;
        const { id, url } = item;
        if (typeof id !== 'string' || !id.trim() || typeof url !== 'string' || !url.trim())
            continue;
        let parsed;
        try {
            parsed = new URL(url);
        }
        catch {
            continue;
        }
        if (parsed.username || parsed.password)
            continue;
        if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && allowsHttp?.(parsed)))
            continue;
        return { id, base: `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`, site: parsed.host };
    }
}
