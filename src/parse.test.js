// Run: npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import * as cheerio from 'cheerio';
import { parseComment, parseLoaders, parsePost, parseRedditUrl, postsFromSearch } from './parse.js';

const html = `
<shreddit-post id="t3_abc" post-title="Hello" subreddit-name="PCOS" author="op" score="12" comment-count="3"
  permalink="/r/PCOS/comments/abc/hello/"><div slot="text-body"><p>Post   body</p></div></shreddit-post>
<shreddit-comment thingId="t1_a" postId="t3_abc" depth="0" author="x" score="5" permalink="/r/PCOS/comments/abc/comment/a/">
  <details><div><div slot="comment"><p>Top comment</p></div></div></details>
  <shreddit-comment thingId="t1_b" postId="t3_abc" depth="1" author="y" score="1">
    <details><div><div slot="comment"><p>Reply</p></div></div></details>
  </shreddit-comment>
  <faceplate-partial src="/svc/shreddit/more-comments/PCOS/t3_abc?startingDepth=2" method="post"><input name="cursor" value="c1"></faceplate-partial>
</shreddit-comment>
<faceplate-partial src="/svc/shreddit/more-comments/PCOS/t3_abc?top-level=1" method="post"><input name="cursor" value="c2"></faceplate-partial>`;

test('parses posts, nested comments and loaders', () => {
    const $ = cheerio.load(html);
    const post = parsePost($, $('shreddit-post')[0]);
    assert.equal(post.id, 't3_abc');
    assert.equal(post.body, 'Post   body');
    assert.equal(post.numComments, 3);

    const [top, reply] = $('shreddit-comment').toArray().map((el) => parseComment($, el, 't3_abc'));
    assert.deepEqual([top.body, top.parentId], ['Top comment', 't3_abc']); // not the reply's text
    assert.deepEqual([reply.body, reply.parentId], ['Reply', 't1_a']);

    const loaders = parseLoaders($);
    assert.deepEqual(loaders.map((l) => [l.cursor, l.isReplyBranch, l.parentId]), [['c1', true, 't1_a'], ['c2', false, undefined]]);
    // On a reply-branch page every loader continues that branch.
    assert.ok(parseLoaders($, 't1_z').every((l) => l.isReplyBranch));
});

test('keeps unique Reddit posts from Google results', () => {
    const results = [
        { url: 'https://www.reddit.com/r/PCOS/comments/abc/metformin/', title: 'r/PCOS on Reddit: Metformin?', description: 'It&#x27;s <strong>metformin</strong>' },
        { url: 'https://www.reddit.com/r/PCOS/', title: 'r/PCOS' }, // not a post
        { url: 'https://reddit.com/r/PCOS/comments/abc/', title: 'dupe' },
        { url: 'https://evil.com/r/PCOS/comments/zzz/', title: 'not reddit' },
    ];
    assert.deepEqual(postsFromSearch(results), [{ id: 't3_abc', subreddit: 'PCOS', title: 'Metformin?', body: "It's metformin" }]);
});

test('parses pasted URLs', () => {
    assert.deepEqual(parseRedditUrl('reddit.com/r/PCOS/comments/abc/x/'), { kind: 'post', sub: 'PCOS', id: 't3_abc' });
    assert.deepEqual(parseRedditUrl('https://www.reddit.com/r/PCOS/top/'), { kind: 'sub', name: 'PCOS' });
    assert.deepEqual(parseRedditUrl('https://www.reddit.com/u/spez'), { kind: 'user', name: 'spez' });
    assert.equal(parseRedditUrl('https://example.com/'), null);
});
