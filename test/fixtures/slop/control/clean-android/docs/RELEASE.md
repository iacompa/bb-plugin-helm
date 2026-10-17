# Release checklist

1. Bump `versionCode` / `versionName` in `app/build.gradle.kts`.
2. Run `./gradlew testReleaseUnitTest lintRelease`.
3. TODO before 2.0: move rates to WorkManager.

Never `println` in release code; use `AppLog`.
