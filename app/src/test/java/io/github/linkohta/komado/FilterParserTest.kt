package io.github.linkohta.komado

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FilterParserTest {

    private val rules = FilterParser.parse(
        listOf(
            """
            ! comment
            [Adblock Plus 2.0]
            ||doubleclick.net^
            ||googlesyndication.com^${'$'}third-party,script
            ||youtube.com/api/stats/ads
            ||youtube.com/pagead/^
            ||youtube.com/api/stats/watchtime
            ||tracker.example^${'$'}domain=example.org
            ||yt-only.example^${'$'}script,domain=youtube.com|m.youtube.com
            ||firstparty.example^${'$'}~third-party
            ||csp.example^${'$'}csp=script-src 'none'
            @@||static.doubleclick.net/instream/ad_status.js${'$'}script,domain=ignboards.com
            @@||pubads.g.doubleclick.net/ondemand/${'$'}domain=youtube.com
            /generic-ad-path/
            youtube.com##ytm-promoted-video-renderer
            m.youtube.com,example.com##.ad-banner
            ~youtube.com,example.com##.not-for-yt
            ##.generic-ad
            youtube.com##.foo:has-text(Sponsored)
            youtube.com##+js(json-prune, adPlacements)
            """.trimIndent(),
        ),
    )

    @Test
    fun blocksHostRulesIncludingSubdomains() {
        assertTrue(rules.matches("doubleclick.net", "/"))
        assertTrue(rules.matches("googleads.g.doubleclick.net", "/pagead/id"))
        assertTrue(rules.matches("pagead2.googlesyndication.com", "/x.js"))
        assertFalse(rules.matches("notdoubleclick.net", "/"))
    }

    @Test
    fun blocksYouTubeAdPaths() {
        assertTrue(rules.matches("m.youtube.com", "/api/stats/ads?ver=2"))
        assertTrue(rules.matches("www.youtube.com", "/pagead/viewthroughconversion"))
        assertFalse(rules.matches("m.youtube.com", "/api/stats/qoe?x=1"))
    }

    @Test
    fun neverBlocksProtectedRequests() {
        // 視聴履歴・再生・動画本体は汎用リストに載っていても通す
        assertFalse(rules.matches("m.youtube.com", "/api/stats/watchtime?ns=yt"))
        assertFalse(rules.matches("m.youtube.com", "/youtubei/v1/player?key=x"))
        assertFalse(rules.matches("rr1---sn-abc.googlevideo.com", "/videoplayback?id=1"))
    }

    @Test
    fun domainOptionOnlyAppliesWhenItTargetsYouTube() {
        assertFalse(rules.matches("tracker.example", "/"))
        assertTrue(rules.matches("yt-only.example", "/a.js"))
        // 他サイト用の例外は全体に広げない
        assertTrue(rules.matches("static.doubleclick.net", "/instream/ad_status.js"))
        // YouTube 用の例外は効く
        assertFalse(rules.matches("pubads.g.doubleclick.net", "/ondemand/hls/content"))
    }

    @Test
    fun skipsRulesWithUnsupportedOptionsOrPatterns() {
        assertFalse(rules.matches("firstparty.example", "/"))
        assertFalse(rules.matches("csp.example", "/"))
        assertFalse(rules.matches("any.example", "/generic-ad-path/x"))
    }

    @Test
    fun keepsOnlyYouTubeCosmeticSelectorsUsableAsCss() {
        assertEquals(listOf("ytm-promoted-video-renderer", ".ad-banner"), rules.cosmeticSelectors)
    }
}
