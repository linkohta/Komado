package io.github.linkohta.komado

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * 実際の EasyList / EasyPrivacy で YouTube の視聴が壊れないかを確認する。
 * 環境変数 KOMADO_FILTER_DIR に easylist.txt / easyprivacy.txt を置いたディレクトリを指定したときだけ実行。
 */
class RealFilterListTest {

    @Test
    fun realListsBlockAdsButNotPlayback() {
        val dir = System.getenv("KOMADO_FILTER_DIR")?.let(::File)
        assumeTrue(dir != null && File(dir, "easylist.txt").exists())
        val bundled = File("src/main/assets/filters.txt").readText()
        val lists = listOf("easylist.txt", "easyprivacy.txt").map { File(dir, it).readText() }

        val start = System.nanoTime()
        val rules = FilterParser.parse(listOf(bundled) + lists)
        println("parse: ${(System.nanoTime() - start) / 1_000_000} ms, cosmetic: ${rules.cosmeticSelectors.size}")

        assertTrue(rules.matches("googleads.g.doubleclick.net", "/pagead/id"))
        assertTrue(rules.matches("www.google-analytics.com", "/analytics.js"))
        assertTrue(rules.matches("m.youtube.com", "/api/stats/ads?ver=2"))
        assertTrue(rules.matches("static.doubleclick.net", "/instream/ad_status.js"))

        val mustLoad = listOf(
            "m.youtube.com" to "/",
            "m.youtube.com" to "/s/player/1b3be681/player-plasma-es6-en_US.vflset/base.js",
            "m.youtube.com" to "/youtubei/v1/player?prettyPrint=false",
            "m.youtube.com" to "/youtubei/v1/next?prettyPrint=false",
            "m.youtube.com" to "/youtubei/v1/browse?prettyPrint=false",
            "m.youtube.com" to "/api/stats/watchtime?ns=yt",
            "m.youtube.com" to "/api/stats/playback?ns=yt",
            "rr3---sn-abc.googlevideo.com" to "/videoplayback?expire=1",
            "i.ytimg.com" to "/vi/dQw4w9WgXcQ/hqdefault.jpg",
            "yt3.ggpht.com" to "/avatar.jpg",
            "accounts.google.com" to "/ServiceLogin",
            "www.gstatic.com" to "/recaptcha/x.js",
            "fonts.googleapis.com" to "/css2?family=Roboto",
            "sponsor.ajay.app" to "/api/skipSegments/abcd",
        )
        for ((host, path) in mustLoad) assertFalse("$host$path", rules.matches(host, path))
    }
}
