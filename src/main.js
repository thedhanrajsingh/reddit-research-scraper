// Reddit scraper without the Reddit API (no OAuth, no .json, no RSS). It reads the HTML fragments
// ("shreddit partials") www.reddit.com loads for itself; pagination links come from the HTML:
//   subreddit feed : /svc/shreddit/community-more-posts/{sort}/?name={sub}&t={TIME}
//   user posts     : /svc/shreddit/profiles/profile_overview-more-posts/{sort}/?name={user}
//   comments       : /svc/shreddit/comments/r/{sub}/t3_{id}?sort={SORT}
//   more comments  : POST {loader src} with the loader's hidden cursor
import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';
import { BASE, parseComment, parseLoaders, parsePost, parseRedditUrl, postsFromSearch, postUrl } from './parse.js';
import { setTimeout as sleep } from 'node:timers/promises';

await Actor.init();

const {
    subreddits = [],
    urls = [],
    users = [],
    searchQueries = [],
    braveApiKey = process.env.BRAVE_API_KEY, // input wins; env var (Actor settings) lets API/MCP/schedules search without it
    sort = 'hot',
    timeFilter = 'week',
    maxPostsPerSource = 50,
    includeComments = true,
    maxCommentsPerPost = 100,
    commentSort = 'top',
    expandReplies = false,
    minPostScore = 0,
    includeNSFW = false,
    proxyConfiguration: proxyInput,
} = (await Actor.getInput()) ?? {};

const COMMENT_SORTS = { best: 'CONFIDENCE', top: 'TOP', new: 'NEW', controversial: 'CONTROVERSIAL', old: 'OLD', qa: 'QA' };
const USER_SORTS = ['hot', 'new', 'top'];

const feedUrl = (kind, name) => {
    const u = new URL(kind === 'user'
        ? `/svc/shreddit/profiles/profile_overview-more-posts/${USER_SORTS.includes(sort) ? sort : 'new'}/`
        : `/svc/shreddit/community-more-posts/${sort}/`, BASE);
    u.searchParams.set('name', name);
    if (kind === 'sub' && ['top', 'controversial'].includes(sort)) u.searchParams.set('t', timeFilter.toUpperCase());
    return u.href;
};
const commentsRequest = (sub, postId, expectedComments) => ({
    url: `${BASE}/svc/shreddit/comments/r/${sub}/${postId}?sort=${COMMENT_SORTS[commentSort] ?? 'CONFIDENCE'}`,
    userData: { label: 'COMMENTS', postId, sub, expectedComments },
});
const feedRequest = (kind, name) => ({ url: feedUrl(kind, name), userData: { label: 'FEED', source: `${kind}:${name}` } });

const startRequests = [
    ...subreddits.map((s) => feedRequest('sub', s.replace(/^\/?r\//i, '').trim())),
    ...users.map((u) => feedRequest('user', u.replace(/^\/?u(ser)?\//i, '').trim())),
];
for (const raw of urls) {
    const r = parseRedditUrl(raw);
    if (!r) log.warning(`Unsupported URL, skipping: ${raw}`);
    else if (r.kind === 'post') startRequests.push(commentsRequest(r.sub, r.id));
    else startRequests.push(feedRequest(r.kind, r.name));
}
// Keyword search: Reddit's own search is behind its bot check, so use the Brave Search API
// (site:reddit.com), then scrape the posts it finds like pasted post URLs.
if (searchQueries.length && !braveApiKey) {
    await Actor.fail('Search keywords need a Brave Search API key: set the "Brave Search API key" input or a BRAVE_API_KEY environment variable (free tier at https://brave.com/search/api/).');
}
const found = new Map(); // postId -> post
for (const query of searchQueries) {
    let n = 0;
    for (let page = 0; page < 10 && n < maxPostsPerSource; page++) { // Brave: 20 results/page, pages 0-9
        const params = new URLSearchParams({ q: `site:reddit.com ${query}`, count: 20, offset: page });
        const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
            headers: { 'X-Subscription-Token': braveApiKey, Accept: 'application/json' },
        });
        if (!res.ok) {
            await Actor.pushData({ type: 'error', stage: 'search', source: `search:${query}`, reason: `Brave API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` });
            break;
        }
        const data = await res.json();
        for (const p of postsFromSearch(data.web?.results ?? [])) {
            if (n >= maxPostsPerSource || found.has(p.id)) continue;
            found.set(p.id, { ...p, source: `search:${query}` });
            n++;
        }
        if (!data.query?.more_results_available) break;
        await sleep(1100); // ponytail: fixed pause for the free tier's 1 request/second; parse rate-limit headers if on a paid plan
    }
}
if (searchQueries.length) log.info(`Search found ${found.size} Reddit posts`);
for (const p of found.values()) {
    await Actor.pushData({ type: 'post', ...p, url: postUrl(p.subreddit, p.id) });
    if (includeComments) startRequests.push(commentsRequest(p.subreddit, p.id));
}
if (!startRequests.length && !searchQueries.length) await Actor.fail('Nothing to scrape. Provide a subreddit, user, Reddit URL or search query.');

const postsPerSource = new Map(); // source -> count
const seenPosts = new Set(); // `${source}:${postId}`
const commentsPerPost = new Map(); // postId -> Set(commentId)

const crawler = new CheerioCrawler({
    proxyConfiguration: await Actor.createProxyConfiguration(proxyInput ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }),
    maxConcurrency: 5,
    maxRequestRetries: 6,
    preNavigationHooks: [({ request }, gotOptions) => {
        gotOptions.headers = { ...gotOptions.headers, 'accept-language': 'en-US,en;q=0.9' };
        if (request.method === 'POST') gotOptions.headers['content-type'] = 'application/x-www-form-urlencoded';
    }],
    async requestHandler({ request, $, session, crawler: c }) {
        const { label, source, postId, sub, loaderParentId, expectedComments } = request.userData;
        // Reddit answers a flagged IP with its bot-check page, or a 200 with an empty comment thread.
        // Both: drop this proxy session and let Crawlee retry on a fresh one.
        const emptyThread = label === 'COMMENTS' && expectedComments > 0 && !$('shreddit-comment').length;
        if ($('form[hidden]').length || emptyThread) {
            session?.retire();
            throw new Error(emptyThread ? `Empty comment page (post reports ${expectedComments} comments)` : 'Got bot-check page');
        }

        if (label === 'FEED') {
            let count = postsPerSource.get(source) ?? 0;
            for (const el of $('shreddit-post').toArray()) {
                if (count >= maxPostsPerSource) break;
                const post = parsePost($, el);
                const key = `${source}:${post.id}`;
                if (!post.id || seenPosts.has(key)) continue;
                seenPosts.add(key);
                if ((post.isNSFW && !includeNSFW) || (post.score ?? 0) < minPostScore) continue;
                count++;
                await Actor.pushData({ ...post, source });
                if (includeComments && post.numComments > 0) await c.addRequests([commentsRequest(post.subreddit, post.id, post.numComments)]);
            }
            postsPerSource.set(source, count);
            log.info(`${source}: ${count}/${maxPostsPerSource} posts`);
            const next = $('faceplate-partial[src*="more-posts"]').last().attr('src');
            if (count < maxPostsPerSource && next) await c.addRequests([{ url: new URL(next, BASE).href, userData: request.userData }]);
            return;
        }

        // COMMENTS / MORE_COMMENTS
        if (!commentsPerPost.has(postId)) commentsPerPost.set(postId, new Set());
        const seen = commentsPerPost.get(postId);
        for (const el of $('shreddit-comment').toArray()) {
            if (seen.size >= maxCommentsPerPost) return;
            const comment = parseComment($, el, postId, loaderParentId);
            if (!comment.id || seen.has(comment.id)) continue;
            seen.add(comment.id);
            await Actor.pushData({ ...comment, subreddit: sub });
        }
        await c.addRequests(parseLoaders($, loaderParentId)
            .filter((l) => expandReplies || !l.isReplyBranch)
            .map((l) => ({
                url: new URL(l.src, BASE).href,
                method: 'POST',
                payload: new URLSearchParams({ cursor: l.cursor, csrf_token: '' }).toString(),
                useExtendedUniqueKey: true,
                userData: { label: 'MORE_COMMENTS', postId, sub, loaderParentId: l.parentId },
            })));
    },
    async failedRequestHandler({ request }, error) {
        const { label, source, postId, sub } = request.userData;
        log.error(`Failed ${request.url}: ${error.message}`);
        await Actor.pushData({
            type: 'error',
            stage: { FEED: 'feed', COMMENTS: 'comments', MORE_COMMENTS: 'replies' }[label],
            source: source ?? null,
            postId: postId ?? null,
            subreddit: sub ?? null,
            // Paste these into "Reddit URLs" in a new run to retry just the failed posts.
            postUrl: postId && sub ? postUrl(sub, postId) : null,
            reason: error.message.slice(0, 300),
        });
    },
});

const { requestsFailed } = await crawler.run(startRequests);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
log.info(`Done. Posts: ${sum([...postsPerSource.values()])}, comments: ${sum([...commentsPerPost.values()].map((s) => s.size))}, `
    + `failed: ${requestsFailed}${requestsFailed ? ' (re-run the postUrl values of the "error" items)' : ''}`);
await Actor.exit();
