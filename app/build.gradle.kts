import org.gradle.process.ExecOperations
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import javax.inject.Inject

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.github.linkohta.komado"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.linkohta.komado"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // 個人利用のサイドロード前提なので debug 鍵で署名する
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.media:media:1.7.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    testImplementation("junit:junit:4.13.2")
}

// ---------------------------------------------------------------- ページに注入するスクリプト（web/）

/**
 * web/ の TypeScript を型検査して komado.js 1 本にバンドルし、生成アセットとして APK に入れる。
 * Node.js（npm）が必要。web/node_modules が無ければ最初に npm ci する。
 */
abstract class BundleWebScripts : DefaultTask() {
    @get:Internal
    abstract val webDir: DirectoryProperty

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sources: ConfigurableFileCollection

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @get:Inject
    abstract val execOperations: ExecOperations

    @TaskAction
    fun bundle() {
        val dir = webDir.get().asFile
        val out = outputDir.get().asFile
        out.deleteRecursively()
        out.mkdirs()
        if (!dir.resolve("node_modules").isDirectory) npm(dir, "ci")
        npm(dir, "run", "build", "--", "--outdir=${out.absolutePath}")
    }

    private fun npm(dir: File, vararg args: String) {
        val windows = System.getProperty("os.name").startsWith("Windows")
        val command = (if (windows) listOf("cmd", "/c", "npm") else listOf("npm")) + args
        try {
            execOperations.exec {
                workingDir = dir
                commandLine(command)
            }
        } catch (e: Exception) {
            throw GradleException("web/ のビルドに失敗しました（Node.js と npm が必要です）: npm ${args.joinToString(" ")}", e)
        }
    }
}

androidComponents {
    onVariants { variant ->
        val name = variant.name.replaceFirstChar { it.uppercase() }
        val bundle = tasks.register<BundleWebScripts>("bundle${name}WebScripts") {
            val web = layout.projectDirectory.dir("../web")
            webDir.set(web)
            sources.from(web.dir("src"), web.files("package.json", "package-lock.json", "tsconfig.json", "build.mjs"))
        }
        variant.sources.assets?.addGeneratedSourceDirectory(bundle, BundleWebScripts::outputDir)
    }
}
