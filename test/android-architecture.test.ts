import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function readProjectFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(new URL(`../${filePath}`, import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

test("Android host boundaries are explicit extraction seams", async () => {
  const rootPackage = JSON.parse(
    (await readProjectFile("package.json"))!,
  ) as { scripts?: Record<string, string>; workspaces?: string[] };
  const protocolPackage = await readProjectFile(
    "packages/bare-host-protocol/package.json",
  );
  const workletPackage = await readProjectFile(
    "packages/kepos-android-worklet/package.json",
  );
  const settings = await readProjectFile("android/settings.gradle.kts");
  const appBuild = await readProjectFile("android/app/build.gradle.kts");
  const appManifest = await readProjectFile("android/app/src/main/AndroidManifest.xml");
  const foregroundService = await readProjectFile(
    "android/app/src/main/java/io/github/ttalab/kepos/KeposForegroundService.kt",
  );
  const mainActivity = await readProjectFile(
    "android/app/src/main/java/io/github/ttalab/kepos/MainActivity.kt",
  );
  const notificationIcon = await readProjectFile(
    "android/app/src/main/res/drawable/ic_kepos_notification.xml",
  );
  const subscriberRuntime = await readProjectFile("src/runtime/subscriber.ts");
  const gateway = await readProjectFile("src/home/gateway.ts");
  const bareKitSession = await readProjectFile(
    "android/barekit-host/src/main/java/io/github/ttalab/barekit/host/BareKitRuntimeSession.kt",
  );
  const hostBuild = await readProjectFile(
    "android/barekit-host/build.gradle.kts",
  );
  const workflow = await readProjectFile(".github/workflows/check.yml");

  assert.deepEqual(rootPackage.workspaces, ["apps/*", "packages/*"]);
  assert.equal(
    rootPackage.scripts?.["android:fetch-bare-kit"],
    "tsx scripts/fetch-bare-kit.ts",
  );
  assert.equal(
    rootPackage.scripts?.["android:assemble"],
    "npm run android:fetch-bare-kit && npm run android:bundle && ./android/gradlew -p android assembleDebug",
  );
  assert.equal(
    rootPackage.scripts?.["android:bundle"],
    "npm run build:packages && tsc -p tsconfig.bare.json && tsx scripts/build-android-worklet.ts",
  );
  assert.notEqual(
    await readProjectFile("src/android/worklet/main.ts"),
    null,
    "missing real subscriber Worklet entry",
  );
  assert.notEqual(
    await readProjectFile("scripts/fetch-bare-kit.ts"),
    null,
  );
  assert.equal(await readProjectFile("scripts/fetch-bare-kit.mjs"), null);
  assert.equal(await readProjectFile("scripts/fetch-bare-kit.d.mts"), null);
  assert.equal(
    rootPackage.scripts?.["android:check"],
    "npm run android:fetch-bare-kit && npm run android:bundle && ./android/gradlew -p android testDebugUnitTest lintDebug assembleDebug",
  );
  assert.equal(
    rootPackage.scripts?.["android:device-check"],
    "npm run android:fetch-bare-kit && npm run android:bundle && ./android/gradlew -p android connectedDeviceTestAndroidTest",
  );
  assert.notEqual(protocolPackage, null, "missing pure host protocol package");
  assert.notEqual(workletPackage, null, "missing product Worklet package");
  assert.match(settings!, /include\(":app", ":barekit-host"\)/);
  assert.match(appBuild!, /implementation\(project\(":barekit-host"\)\)/);
  assert.match(appBuild!, /abiFilters \+= "arm64-v8a"/);
  assert.doesNotMatch(appBuild!, /bare-kit\/classes\.jar/);
  assert.match(hostBuild!, /bare-kit\/classes\.jar/);
  assert.match(hostBuild!, /libs\/bare-kit\/jni/);
  assert.match(appManifest!, /foregroundServiceType="specialUse"/);
  assert.match(appManifest!, /android\.permission\.POST_NOTIFICATIONS/);
  assert.match(mainActivity!, /ActivityResultContracts\.RequestPermission/);
  assert.match(mainActivity!, /Manifest\.permission\.POST_NOTIFICATIONS/);
  assert.match(foregroundService!, /private val runtime = BareRuntime/);
  assert.match(foregroundService!, /START_STICKY/);
  assert.match(foregroundService!, /R\.drawable\.ic_kepos_notification/);
  assert.match(notificationIcon!, /M15,9H4V31H15M25,9H36V31H25M10,20H30/);
  assert.match(foregroundService!, /filesDir\.resolve\("subscriber"\)/);
  assert.match(foregroundService!, /BuildConfig\.GATEWAY_PORT/);
  assert.match(foregroundService!, /BuildConfig\.NAVIDROME_PORT/);
  assert.doesNotMatch(`${subscriberRuntime}\n${gateway}`, /\bAbortController\b/);
  assert.doesNotMatch(workflow!, /uses: actions\/(?:checkout|setup-node)@v\d/);
  assert.ok(
    bareKitSession!.indexOf("worklet.start") < bareKitSession!.indexOf("armRead()"),
    "Bare Kit IPC reads must begin after the Worklet starts",
  );
  assert.ok(
    bareKitSession!.indexOf("worklet.start") < bareKitSession!.indexOf("IPC(worklet)"),
    "Bare Kit IPC must be created after the Worklet starts",
  );
});

test("Android device commands isolate tests and preserve installed state", async () => {
  const rootPackage = JSON.parse(
    (await readProjectFile("package.json"))!,
  ) as { scripts?: Record<string, string> };
  const appBuild = await readProjectFile("android/app/build.gradle.kts");
  const foregroundService = await readProjectFile(
    "android/app/src/main/java/io/github/ttalab/kepos/KeposForegroundService.kt",
  );
  const lifecycleTest = await readProjectFile(
    "android/app/src/androidTest/java/io/github/ttalab/kepos/WorkletLifecycleTest.kt",
  );
  const worklet = await readProjectFile("src/android/worklet/main.ts");
  const readme = await readProjectFile("README.md");

  assert.equal(
    rootPackage.scripts?.["android:install"],
    "npm run android:assemble && adb install -r android/app/build/outputs/apk/debug/app-debug.apk",
  );
  assert.match(appBuild!, /create\("deviceTest"\)/);
  assert.match(appBuild!, /applicationIdSuffix\s*=\s*"\.devicetest"/);
  assert.match(appBuild!, /GATEWAY_PORT.*18480/);
  assert.match(appBuild!, /NAVIDROME_PORT.*18481/);
  assert.match(foregroundService!, /BuildConfig\.GATEWAY_PORT/);
  assert.match(foregroundService!, /BuildConfig\.NAVIDROME_PORT/);
  assert.match(lifecycleTest!, /BuildConfig\.GATEWAY_PORT/);
  assert.match(lifecycleTest!, /BuildConfig\.NAVIDROME_PORT/);
  assert.match(worklet!, /Bare\.argv\[2\]/);
  assert.match(worklet!, /Bare\.argv\[3\]/);
  assert.match(readme!, /npm run android:install/);
  assert.match(readme!, /io\.github\.ttalab\.kepos\.devicetest/);
  assert.match(readme!, /preserving app-private state/);
});

test("Android subscriber waits for startup and exposes the real service registry", async () => {
  const worklet = await readProjectFile("src/android/worklet/main.ts");
  const runtimeState = await readProjectFile(
    "android/barekit-host/src/main/java/io/github/ttalab/barekit/host/RuntimeStateMachine.kt",
  );
  const screen = await readProjectFile(
    "android/app/src/main/java/io/github/ttalab/kepos/ui/KeposScreen.kt",
  );
  const evidence = await readProjectFile(
    "docs/evidence/android-navic-subscriber-spike.md",
  );

  assert.match(worklet!, /await connectTask/);
  assert.match(worklet!, /readHomeRegistry/);
  assert.match(worklet!, /createAndroidRegistrySnapshot/);
  assert.match(runtimeState!, /val publisher: PublisherSnapshot\?/);
  assert.match(runtimeState!, /val services: List<ServiceSnapshot>/);
  assert.match(screen!, /Your services/);
  assert.doesNotMatch(screen!, /Copy Home URL/);
  assert.doesNotMatch(evidence!, /124\.160\.204\.171/);
});
