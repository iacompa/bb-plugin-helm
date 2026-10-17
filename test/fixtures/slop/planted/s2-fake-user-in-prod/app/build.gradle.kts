plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.example.crew"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.example.crew"
        minSdk = 26
        targetSdk = 35
    }
    buildTypes {
        release {
            isMinifyEnabled = true
        }
    }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.material3)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    testImplementation(libs.junit)
}
