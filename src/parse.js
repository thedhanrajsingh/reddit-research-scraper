// Pure parsers for Reddit's shreddit HTML partials (no I/O, so they can be tested).
import { load } from 'cheerio';

export const BASE = 'https://www.reddit.com';

const text = ($el) => $el.text().replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim() || null;
const num = (v) => (v === undefined || v === '' ? null : Number(v));
const abs = (path) => (path ? BASE + path : null);

export const postUrl = (sub, postId) => `${BASE}/r/${sub}/comments/${postId.replace(/^t3_/, '')}/`;

// Whatever the user pasted -> { kind: 'sub' | 'user', name } | { kind: 'post', sub, id } | null
export function parseRedditUrl(raw) {
    let u;
    try { u = new URL(raw.trim().replace(/^(?!https?:)/, 'https://')); } catch { return null; }
    if (!/(^|\.)reddit\.com$/.test(u.hostname)) return null;
    const p = u.pathname.split('/').filter(Boolean);
    if (p[0] === 'r' && p[2] === 'comments' && p[3]) return { kind: 'post', sub: p[1], id: `t3_${p[3]}` };
    if (p[0] === 'r' && p[1]) return { kind: 'sub', name: p[1] };
    if ((p[0] === 'user' || p[0] === 'u') && p[1]) return { kind: 'user', name: p[1] };
    return null;
}

// Brave Search web.results -> unique Reddit posts. Brave returns HTML snippets (<strong>, &#x27;)
// and titles like "r/PCOS on Reddit: <title>".
export function postsFromSearch(results) {
    const seen = new Set();
    const clean = (s) => (s ? load(s).text().replace(/^r\/\w+ on Reddit: /, '').trim() || null : null);
    return results.map((r) => {
        const ref = parseRedditUrl(r.url);
        if (ref?.kind !== 'post' || seen.has(ref.id)) return null;
        seen.add(ref.id);
        return { id: ref.id, subreddit: ref.sub, title: clean(r.title), body: clean(r.description) };
    }).filter(Boolean);
}

export function parsePost($, el) {
    const $p = $(el);
    const a = (n) => $p.attr(n);
    return {
        type: 'post',
        id: a('id'),
        subreddit: a('subreddit-name'),
        title: a('post-title'),
        body: text($p.find('[slot="text-body"]').first()),
        author: a('author'),
        score: num(a('score')),
        upvoteRatio: num(a('upvote-ratio')),
        numComments: num(a('comment-count')),
        createdAt: a('created-timestamp'),
        postType: a('post-type'),
        flair: text($p.find('shreddit-post-flair').first()),
        domain: a('domain'),
        link: a('content-href'),
        url: abs(a('permalink')),
        isNSFW: $p.is('[nsfw]'),
        isStickied: $p.is('[stickied]'),
    };
}

// loaderParentId: the comment a "more replies" loader hung under (roots of that partial reply to it).
export function parseComment($, el, postId, loaderParentId) {
    const $c = $(el);
    const a = (n) => $c.attr(n);
    const parent = $c.parents('shreddit-comment').first();
    const depth = num(a('depth'));
    return {
        type: 'comment',
        id: a('thingid'),
        postId: a('postid') ?? postId,
        parentId: parent.length ? parent.attr('thingid') : depth === 0 ? (a('postid') ?? postId) : (loaderParentId ?? null),
        depth,
        author: a('author'),
        score: num(a('score')),
        createdAt: a('created'),
        // Text sits a few levels down (details > div > div); skip divs that belong to nested replies.
        body: text($c.find('[slot="comment"]').filter((_, s) => $(s).closest('shreddit-comment')[0] === el).first()),
        url: abs(a('permalink')),
    };
}

// "Load more" loaders on a comments page. A loader inside a comment, or any loader on a page that is
// itself a reply branch, opens collapsed replies; otherwise it pages through more top-level comments.
export function parseLoaders($, loaderParentId) {
    return $('faceplate-partial[src*="/more-comments/"]').toArray().map((el) => {
        const $l = $(el);
        const owner = $l.closest('shreddit-comment');
        return {
            src: $l.attr('src'),
            cursor: $l.children('input[name="cursor"]').attr('value'),
            isReplyBranch: owner.length > 0 || Boolean(loaderParentId),
            parentId: owner.length ? owner.attr('thingid') : loaderParentId,
        };
    }).filter((l) => l.src && l.cursor);
}
