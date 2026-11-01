# Changelog

## [0.4.5](https://github.com/quynhonsemiconductor/opshub/compare/v0.4.4...v0.4.5) (2026-11-01)


### ✨ Features

* **web:** deploy the SPA as a Workers static-asset script ([#521](https://github.com/quynhonsemiconductor/opshub/issues/521)) ([36082d5](https://github.com/quynhonsemiconductor/opshub/commit/36082d534e287a194eb39bb51e85838d552012ff))
* **workforce:** attendance core — derived days, justification requests, month close ([#505](https://github.com/quynhonsemiconductor/opshub/issues/505)) ([b1a31e6](https://github.com/quynhonsemiconductor/opshub/commit/b1a31e69677f8b35a5c5993293ab31ddda87dd2e))
* **workforce:** chấm công tab, attendance CSVs, morning flag notification ([#506](https://github.com/quynhonsemiconductor/opshub/issues/506)) ([72cc27f](https://github.com/quynhonsemiconductor/opshub/commit/72cc27fb9cea4dcacd07bfe73db68b799027728e))
* **workforce:** wio calendar + manager-approved wfh requests ([#474](https://github.com/quynhonsemiconductor/opshub/issues/474)) ([1cbaaf9](https://github.com/quynhonsemiconductor/opshub/commit/1cbaaf9187baa3a6b9ad96f3c6d5ac2d4a7ddd8d))


### 🐛 Bug Fixes

* **ci:** sweep callers to ci v1.24.3; drop the removed secret inputs ([#503](https://github.com/quynhonsemiconductor/opshub/issues/503)) ([f5179f8](https://github.com/quynhonsemiconductor/opshub/commit/f5179f8d64ab4e2cf8370febf9b2ed1acff4e452))
* **config:** make the signed edge address optional in production ([#524](https://github.com/quynhonsemiconductor/opshub/issues/524)) ([a171bb2](https://github.com/quynhonsemiconductor/opshub/commit/a171bb29c5eefe1a54b8ff8dfbebe1eaabe00288))
* **db:** build a fresh database on the platform-managed roles ([#519](https://github.com/quynhonsemiconductor/opshub/issues/519)) ([fb0922c](https://github.com/quynhonsemiconductor/opshub/commit/fb0922c1a98e7dba2256a25af51a8690a371cc4c))
* **deps:** bump qs override to 6.16.1+, suppress unfixable deepmerge advisory ([#507](https://github.com/quynhonsemiconductor/opshub/issues/507)) ([b6a4d18](https://github.com/quynhonsemiconductor/opshub/commit/b6a4d1821f796e446ca647d8f7ef42f175430bf8))
* **deps:** drop .pnpmfile.cjs for declarative better-auth peer overrides ([#499](https://github.com/quynhonsemiconductor/opshub/issues/499)) ([d46f32b](https://github.com/quynhonsemiconductor/opshub/commit/d46f32b82714567f539bcf763ddfa82727b2558f))
* **deps:** floor systeminformation &gt;=5.33.16 and seroval &gt;=1.6.11 ([#514](https://github.com/quynhonsemiconductor/opshub/issues/514)) ([1e278fd](https://github.com/quynhonsemiconductor/opshub/commit/1e278fd1a8e3ad11f1cd3cfcb302e17c9efc54fe))
* **deps:** force glob and minimatch past their advisories ([#517](https://github.com/quynhonsemiconductor/opshub/issues/517)) ([c3f9351](https://github.com/quynhonsemiconductor/opshub/commit/c3f9351045203370fe72d53f9524d753fc3c2207))
* **deps:** minimumReleaseAgeStrict: false so Renovate can regenerate lockfiles ([#502](https://github.com/quynhonsemiconductor/opshub/issues/502)) ([efa309e](https://github.com/quynhonsemiconductor/opshub/commit/efa309e283a48d8ca60669dd3308c1c7e88fb2ea))
* **deps:** scope the prod-tree peer check to each project's own dependencies ([#501](https://github.com/quynhonsemiconductor/opshub/issues/501)) ([67b56c4](https://github.com/quynhonsemiconductor/opshub/commit/67b56c476e9ff034dbb9338dc4a7dfb028aefeb3))
* **deps:** update npm production (non-major) ([#419](https://github.com/quynhonsemiconductor/opshub/issues/419)) ([c2af86c](https://github.com/quynhonsemiconductor/opshub/commit/c2af86ce109b059e8d88564fa2bc9fa26d9d35fd))
* **door:** drop only the enrolled UID from the unknown list ([#522](https://github.com/quynhonsemiconductor/opshub/issues/522)) ([28baae9](https://github.com/quynhonsemiconductor/opshub/commit/28baae9948de33fb386fd9d40c151b614782f78d))
* **door:** implausible battery telemetry must not refuse an event batch ([#518](https://github.com/quynhonsemiconductor/opshub/issues/518)) ([07f7c20](https://github.com/quynhonsemiconductor/opshub/commit/07f7c205eeddd1dd92b81da5210b18278f98796b))
* **door:** terminal contract v1 — epoch-second windows, unsynced events ([#508](https://github.com/quynhonsemiconductor/opshub/issues/508)) ([06bcbc8](https://github.com/quynhonsemiconductor/opshub/commit/06bcbc85d07ad5599121798281248618d77a807f))
* **logging:** nestjs-pino 5.3.1 stops the /v1/* wildcard warning ([#523](https://github.com/quynhonsemiconductor/opshub/issues/523)) ([5aab4d3](https://github.com/quynhonsemiconductor/opshub/commit/5aab4d3fedbf7c305e76f76e4d5f13610afbfec2))

## [0.4.4](https://github.com/quynhonsemiconductor/opshub/compare/v0.4.3...v0.4.4) (2026-10-26)


### ✨ Features

* **db:** door terminal schema, migration 0040 and permission seeds ([#478](https://github.com/quynhonsemiconductor/opshub/issues/478)) ([153a160](https://github.com/quynhonsemiconductor/opshub/commit/153a1603c491544774b33a75501d94d2b394c9aa))
* **door:** admin module — terminals, cards and the enrolment UI ([#479](https://github.com/quynhonsemiconductor/opshub/issues/479)) ([c6c309f](https://github.com/quynhonsemiconductor/opshub/commit/c6c309f5ed542fc28ac6238776396430e9f26a96))
* **door:** battery telemetry, low-battery alerts and the 150-min offline window ([#493](https://github.com/quynhonsemiconductor/opshub/issues/493)) ([85d51eb](https://github.com/quynhonsemiconductor/opshub/commit/85d51eb15fd33b6fb8fa544395947e7e21ce1fc3))
* **door:** terminal routes — token guard, allow-list ETag, event ingestion, jobs ([#480](https://github.com/quynhonsemiconductor/opshub/issues/480)) ([2942b7a](https://github.com/quynhonsemiconductor/opshub/commit/2942b7a813af87c5edf53073f7705e3a3f3c681e))
* **email:** refuse unreplaced Graph placeholders in the environment ([#412](https://github.com/quynhonsemiconductor/opshub/issues/412)) ([da8b211](https://github.com/quynhonsemiconductor/opshub/commit/da8b211f1d7363e2a796bc96b6f36871465df488))
* **graph:** read the certificate from AZURE_CLIENT_CERTIFICATE_PATH ([#449](https://github.com/quynhonsemiconductor/opshub/issues/449)) ([7a05449](https://github.com/quynhonsemiconductor/opshub/commit/7a0544954d49dbea4b871b90aee076d08c3aa160))


### 🐛 Bug Fixes

* **ci:** take the one-shot garage-init out of compose's wait set ([#496](https://github.com/quynhonsemiconductor/opshub/issues/496)) ([fcc3ef4](https://github.com/quynhonsemiconductor/opshub/commit/fcc3ef4dfa1a2ee2a8992302a5cb4dd3efd426ac))
* **config:** use the certificate path in the placeholder-guard spec ([#490](https://github.com/quynhonsemiconductor/opshub/issues/490)) ([fffc9c5](https://github.com/quynhonsemiconductor/opshub/commit/fffc9c55ba8ec9cd64f82df82392b5d67535acb6))
* **deps:** allow workerd and sharp build scripts for the deploy-time wrangler install ([#495](https://github.com/quynhonsemiconductor/opshub/issues/495)) ([9a4fcc6](https://github.com/quynhonsemiconductor/opshub/commit/9a4fcc634b971044964f4f28aee2ad8f25efea07))
* **worker:** materialize the injected graph certificate as the file the app reads ([#492](https://github.com/quynhonsemiconductor/opshub/issues/492)) ([e8e350e](https://github.com/quynhonsemiconductor/opshub/commit/e8e350ec1daa7c436f47f2e24f7fc9c81fe47747))

## [0.4.3](https://github.com/quynhonsemiconductor/opshub/compare/v0.4.2...v0.4.3) (2026-10-25)


### ✨ Features

* **ci:** e2e in the official playwright container ([#483](https://github.com/quynhonsemiconductor/opshub/issues/483)) ([8da9610](https://github.com/quynhonsemiconductor/opshub/commit/8da96106f1432452b2960936511503ac5e994721))
* **ci:** publish images to ghcr on merge (on-prem delivery path) ([#476](https://github.com/quynhonsemiconductor/opshub/issues/476)) ([4983092](https://github.com/quynhonsemiconductor/opshub/commit/4983092957ce8b5a218ec79cb44b926a46b67f5c))


### 🐛 Bug Fixes

* **ci:** recover dpkg state between install-deps attempts ([#477](https://github.com/quynhonsemiconductor/opshub/issues/477)) ([e5430b1](https://github.com/quynhonsemiconductor/opshub/commit/e5430b1f549f3ac5a743e9f0391c030bff62f144))
* **deps:** bump vitest to 4.1.12 for two @vitest/mocker advisories ([#466](https://github.com/quynhonsemiconductor/opshub/issues/466)) ([bfe070c](https://github.com/quynhonsemiconductor/opshub/commit/bfe070c45653c87b6683c87f0b5eda20103616e6))
* **deps:** bump zod to ^4.6.6 (GHSA-mrhx-c7xc-m3w5) ([#482](https://github.com/quynhonsemiconductor/opshub/issues/482)) ([1eb5fd9](https://github.com/quynhonsemiconductor/opshub/commit/1eb5fd97db570668b1e65f8735d8757fe5f597b3))
* **deps:** fastify 5.12.7 for GHSA-389g-gv7q-r4x8 ([#471](https://github.com/quynhonsemiconductor/opshub/issues/471)) ([855fc16](https://github.com/quynhonsemiconductor/opshub/commit/855fc1696a55f13f0b5e771deaaedae05fa7bf82))

## [0.4.2](https://github.com/quynhonsemiconductor/opshub/compare/v0.4.1...v0.4.2) (2026-10-21)


### 🐛 Bug Fixes

* **infra:** allow the RDS instance and uploads bucket destroys ([#462](https://github.com/quynhonsemiconductor/opshub/issues/462)) ([491ec0b](https://github.com/quynhonsemiconductor/opshub/commit/491ec0b556f7c088fd5d4338a858fa1ffe92e09f))

## [0.4.1](https://github.com/quynhonsemiconductor/opshub/compare/v0.4.0...v0.4.1) (2026-10-21)


### 🐛 Bug Fixes

* **infra:** allow the exact 12 gated destroys the plan-guard refused ([#460](https://github.com/quynhonsemiconductor/opshub/issues/460)) ([ae76377](https://github.com/quynhonsemiconductor/opshub/commit/ae7637759a0ff57c747e3b61369a24196068a61a))

## [0.4.0](https://github.com/quynhonsemiconductor/opshub/compare/v0.3.1...v0.4.0) (2026-10-21)


### ⚠ BREAKING CHANGES

* **logging:** log lines carry level as a label and time as ISO-8601 UTC
* **graph:** POST /v1/compliance/shadow-it/scan and POST /v1/security-posture/sync now answer 202 with { queued }; the shadow-it scan no longer returns { scanned, newFindings }. GRAPH_CLIENT_SECRET is removed; the develop stack's graph-client-secret container is destroyed by the next apply.

### ✨ Features

* **dev:** opshub sends to Mailpit in development through smtp ([#431](https://github.com/quynhonsemiconductor/opshub/issues/431)) ([f4f20e2](https://github.com/quynhonsemiconductor/opshub/commit/f4f20e2302f2bc2449ac12a38480de6ff8eb69c3))
* **dev:** opshub takes its own port block (5410, 6310, 4610, 4410/8410, web 5174) ([#427](https://github.com/quynhonsemiconductor/opshub/issues/427)) ([c0c739b](https://github.com/quynhonsemiconductor/opshub/commit/c0c739bb206943032605edc21842ae2079def6de))
* **email:** send through Microsoft 365 (Graph), switched off ([#403](https://github.com/quynhonsemiconductor/opshub/issues/403)) ([4c91f8a](https://github.com/quynhonsemiconductor/opshub/commit/4c91f8aeaa390f99a8cd62aff5bb75109017b818))
* **identity:** adopt identity 8.4.1 ([#409](https://github.com/quynhonsemiconductor/opshub/issues/409)) ([f3c0a6e](https://github.com/quynhonsemiconductor/opshub/commit/f3c0a6e28b3c68e9bc077a3f7b94f27befa64a66))
* **identity:** move opshub to identity 8 ([#355](https://github.com/quynhonsemiconductor/opshub/issues/355)) ([6b38c68](https://github.com/quynhonsemiconductor/opshub/commit/6b38c68afcb510fda6bee4f71c695040ba23da45))
* **infra:** production on the secrets bundle ([#372](https://github.com/quynhonsemiconductor/opshub/issues/372)) ([1483c2c](https://github.com/quynhonsemiconductor/opshub/commit/1483c2ca77a2fb46c761d10f773e302248557c6d))
* **infra:** switch develop to Microsoft 365 (Graph) mail ([#407](https://github.com/quynhonsemiconductor/opshub/issues/407)) ([1cf6b68](https://github.com/quynhonsemiconductor/opshub/commit/1cf6b6807186ef8b6927bede6ba0c03e2ac7f5c4))
* **infra:** wire Microsoft 365 mail (Graph) per environment, switched off, with the owner runbook ([#404](https://github.com/quynhonsemiconductor/opshub/issues/404)) ([f8f43c4](https://github.com/quynhonsemiconductor/opshub/commit/f8f43c445df6d26159db890c8627864f3627771d))
* **local:** replace LocalStack with Garage; add make local and make check ([#439](https://github.com/quynhonsemiconductor/opshub/issues/439)) ([28e5b4d](https://github.com/quynhonsemiconductor/opshub/commit/28e5b4d5feeea60fd796906f08d857fafe3cdc7e))
* **logging:** adopt the shared bootstrap and one log shape ([#384](https://github.com/quynhonsemiconductor/opshub/issues/384)) ([24801ad](https://github.com/quynhonsemiconductor/opshub/commit/24801adb336bcf219a6964e2aa7dfbd5e4d93258))
* **outbox:** wake the relays with LISTEN/NOTIFY, polling stays the source of truth ([#440](https://github.com/quynhonsemiconductor/opshub/issues/440)) ([21a9bb7](https://github.com/quynhonsemiconductor/opshub/commit/21a9bb7f8b3d7120e5db78c480daadf99f2db9cb))
* **platform:** adopt platform-http 5's principal contract ([#410](https://github.com/quynhonsemiconductor/opshub/issues/410)) ([6579806](https://github.com/quynhonsemiconductor/opshub/commit/6579806c8c6c14631fc108087144313202a7ec16))
* serve /livez for Kubernetes, and immutable ECR tags ([#337](https://github.com/quynhonsemiconductor/opshub/issues/337)) ([14b7a40](https://github.com/quynhonsemiconductor/opshub/commit/14b7a40039ef6090fa69eb270504fa6cdb7a9483))
* **web:** add public/_headers with CSP, HSTS and immutable assets ([#446](https://github.com/quynhonsemiconductor/opshub/issues/446)) ([a9f4ae3](https://github.com/quynhonsemiconductor/opshub/commit/a9f4ae35544e734cdffc6c03f49e8aa50444d584))
* **web:** reload once on vite:preloadError ([#445](https://github.com/quynhonsemiconductor/opshub/issues/445)) ([a5dd1a5](https://github.com/quynhonsemiconductor/opshub/commit/a5dd1a5ab6ad370b14707eae03d0d76c6e48d7b2))


### 🐛 Bug Fixes

* **api:** give the two CancelReviewDto classes unique names ([#423](https://github.com/quynhonsemiconductor/opshub/issues/423)) ([0ec2298](https://github.com/quynhonsemiconductor/opshub/commit/0ec22980f2d78f9bee071dc0f9f36fa5056a96a5))
* **auth:** issue __Host- session cookies in production ([#444](https://github.com/quynhonsemiconductor/opshub/issues/444)) ([4b29da3](https://github.com/quynhonsemiconductor/opshub/commit/4b29da36cc0d1925ed6ba0f54646067701a5dcaf))
* **cache,alerts:** join the shared develop Valkey, and route alarms to devops@ ([#333](https://github.com/quynhonsemiconductor/opshub/issues/333)) ([0ce3a0b](https://github.com/quynhonsemiconductor/opshub/commit/0ce3a0bbc1d2a216fc7e1f6608db4cc83f5e62ad))
* **ci:** restore infra-plan.yml, which a bad edit emptied ([#339](https://github.com/quynhonsemiconductor/opshub/issues/339)) ([68b2306](https://github.com/quynhonsemiconductor/opshub/commit/68b23064d3075ac40573b5e0d06bc08e647b049d))
* **ci:** run CI on stacked pull requests, not only PRs aimed at main ([#330](https://github.com/quynhonsemiconductor/opshub/issues/330)) ([fee1264](https://github.com/quynhonsemiconductor/opshub/commit/fee1264dfcc908071aac07686e0598b34435dd64))
* **db:** verify-full TLS from DATABASE_SSL_CA, fail closed in production ([#448](https://github.com/quynhonsemiconductor/opshub/issues/448)) ([5e07206](https://github.com/quynhonsemiconductor/opshub/commit/5e07206ed015e3c52f02eaf10bff8f04fdc97e76))
* **deps:** clear the osv-scanner findings that block the required check ([#352](https://github.com/quynhonsemiconductor/opshub/issues/352)) ([495cf20](https://github.com/quynhonsemiconductor/opshub/commit/495cf20309ae60bda2413aec26903a6e6cea4ae6))
* **deps:** observability 0.4.2 (credential leak in error logging) ([#386](https://github.com/quynhonsemiconductor/opshub/issues/386)) ([16c253b](https://github.com/quynhonsemiconductor/opshub/commit/16c253b4f0d87d33d70af447b7c5ea65e3905f48))
* **deps:** platform-cache ^3.2.0, which platform-runtime 0.2.0 requires ([#387](https://github.com/quynhonsemiconductor/opshub/issues/387)) ([8865f54](https://github.com/quynhonsemiconductor/opshub/commit/8865f546bafcc3f389aa60019a50ab35e9c5d327))
* **deps:** update @quynhonsemiconductor/identity and platform-cache ([#322](https://github.com/quynhonsemiconductor/opshub/issues/322)) ([60c938f](https://github.com/quynhonsemiconductor/opshub/commit/60c938f2aec11e1e4c6ab94ed11eb7781bf69468))
* **deps:** update dependency fastify to v5.12.4 [security] ([#332](https://github.com/quynhonsemiconductor/opshub/issues/332)) ([74b2a0d](https://github.com/quynhonsemiconductor/opshub/commit/74b2a0dc3619b10a91d90857254299aa07fd2212))
* **dev:** make down stops the process tree; e2e database is created by the stack ([#442](https://github.com/quynhonsemiconductor/opshub/issues/442)) ([5a9f9f2](https://github.com/quynhonsemiconductor/opshub/commit/5a9f9f22ac04e829a68ce96bbb1952c6437d9a73))
* **dev:** run a second local copy without container or port clashes ([#422](https://github.com/quynhonsemiconductor/opshub/issues/422)) ([62be699](https://github.com/quynhonsemiconductor/opshub/commit/62be699e7f637721e4ec54bff34d6dd92355c574))
* **graph:** account disable and session revoke fail closed where the permission is not granted ([#406](https://github.com/quynhonsemiconductor/opshub/issues/406)) ([0525310](https://github.com/quynhonsemiconductor/opshub/commit/05253109bab3c0d02e420da96fe3bd31ce850f09))
* **infra:** alert on a failing scheduled job, whatever the volume ([#389](https://github.com/quynhonsemiconductor/opshub/issues/389)) ([331ef68](https://github.com/quynhonsemiconductor/opshub/commit/331ef685e2c6bb8d160b65c76ddba79c7c5b4cd8))
* **infra:** fail closed when the Cloudflare zone id is missing ([#359](https://github.com/quynhonsemiconductor/opshub/issues/359)) ([e937864](https://github.com/quynhonsemiconductor/opshub/commit/e937864468f4e01e7dade84236960c90c045cb72))
* **infra:** no 'latest' baseline image tag; reject it in the stack module ([#368](https://github.com/quynhonsemiconductor/opshub/issues/368)) ([1269072](https://github.com/quynhonsemiconductor/opshub/commit/12690728b5ee1979c8a2ad4ab3f383806b1f948b))
* **infra:** point the outbound-HTTP panel at the series instrumentation-http 0.221 emits ([#371](https://github.com/quynhonsemiconductor/opshub/issues/371)) ([b2bbd81](https://github.com/quynhonsemiconductor/opshub/commit/b2bbd8111ec9cdb8284db5d4724af34c1c14bb7b))
* **infra:** production ingress through the Cloudflare tunnel, like develop ([#374](https://github.com/quynhonsemiconductor/opshub/issues/374)) ([cb1ae92](https://github.com/quynhonsemiconductor/opshub/commit/cb1ae92bf1355497473f47f7411de286fe6c2570))
* **infra:** set DEPLOYMENT_ENV so the logs and the OTel resource name the deployment environment ([#370](https://github.com/quynhonsemiconductor/opshub/issues/370)) ([a47a09e](https://github.com/quynhonsemiconductor/opshub/commit/a47a09e7e3923c62d9ea2c62b02107e2f474c0cb))
* **infra:** start the api service at min_count, not at a literal 1 ([#373](https://github.com/quynhonsemiconductor/opshub/issues/373)) ([fdbd241](https://github.com/quynhonsemiconductor/opshub/commit/fdbd24125ffe86c0276a04eb428357113387320b))
* **infra:** write the tunnel token at apply, not in the plan refresh ([#418](https://github.com/quynhonsemiconductor/opshub/issues/418)) ([c4a8258](https://github.com/quynhonsemiconductor/opshub/commit/c4a8258119cbce25142f1709cc913b1892eb7c18))
* **logging:** pass deploymentEnv to the logger in the api and the worker ([#379](https://github.com/quynhonsemiconductor/opshub/issues/379)) ([e447b2d](https://github.com/quynhonsemiconductor/opshub/commit/e447b2d4472af7b07813f3a53735ddd04bb8c632))
* **outbox:** claims and leases on the database clock, with a skew test per relay ([#433](https://github.com/quynhonsemiconductor/opshub/issues/433)) ([4c604b0](https://github.com/quynhonsemiconductor/opshub/commit/4c604b0a4d4c59d04aab5e438d4d154c8697367e))
* **outbox:** stamp email and webhook rows from the database clock, not the host ([#430](https://github.com/quynhonsemiconductor/opshub/issues/430)) ([e6742d8](https://github.com/quynhonsemiconductor/opshub/commit/e6742d8462252d29f6e0f2b8f114e371702ef035))
* **platform:** converge sanitize.util with rova ([#324](https://github.com/quynhonsemiconductor/opshub/issues/324)) ([453c175](https://github.com/quynhonsemiconductor/opshub/commit/453c17584022cc67cb2446f2932278c5d178789d))
* **platform:** key rate limits on the verified identity, never on a cookie ([#414](https://github.com/quynhonsemiconductor/opshub/issues/414)) ([b335612](https://github.com/quynhonsemiconductor/opshub/commit/b3356124ac2491d207769b5d7275215fae0984e5))
* **platform:** write the unverified principal fallback only for uuid ids ([#420](https://github.com/quynhonsemiconductor/opshub/issues/420)) ([31c3e91](https://github.com/quynhonsemiconductor/opshub/commit/31c3e9173fd43c6e7e9f0e3aa72be80bb768f199))
* **reports:** default the window to the database clock, the clock the rows are stamped with ([#426](https://github.com/quynhonsemiconductor/opshub/issues/426)) ([f8e972a](https://github.com/quynhonsemiconductor/opshub/commit/f8e972ac296183be19fb07f96000a916b6ea40cf))
* **requests:** say why no approver was notified, and tell administrators ([#411](https://github.com/quynhonsemiconductor/opshub/issues/411)) ([e5d8538](https://github.com/quynhonsemiconductor/opshub/commit/e5d853857bb9d71f0d5dfc709dcca0929c423f1c))
* **secrets:** grant IAM on secret containers, not valueFrom references ([#335](https://github.com/quynhonsemiconductor/opshub/issues/335)) ([4cb187b](https://github.com/quynhonsemiconductor/opshub/commit/4cb187bd9ce8e9964b6659bf25d0a9828f710217))
* **test:** make the second-PERMISSION-map ratchet run on macOS ([#328](https://github.com/quynhonsemiconductor/opshub/issues/328)) ([c5f56b0](https://github.com/quynhonsemiconductor/opshub/commit/c5f56b00bc079e64f1f87710c6d8e3990900fe5b))
* **webhooks:** lock only the deliveries in the relay's claim; alert when a relay pass fails ([#378](https://github.com/quynhonsemiconductor/opshub/issues/378)) ([323fa8e](https://github.com/quynhonsemiconductor/opshub/commit/323fa8e5c9fb8a25557b187ce0c9a0fec7f66cf8))


### ♻️ Refactors

* **graph:** run Graph only in the worker, with its own app id, and delete the unused PIM client ([#354](https://github.com/quynhonsemiconductor/opshub/issues/354)) ([0118ef3](https://github.com/quynhonsemiconductor/opshub/commit/0118ef3bb99db7775a067ecee9bd9c20c187b1e3))
* **logging:** main and the conformance specs share one bootstrap options object ([#390](https://github.com/quynhonsemiconductor/opshub/issues/390)) ([e5965a2](https://github.com/quynhonsemiconductor/opshub/commit/e5965a243b3cecdcef4aa145d63a7ab3fdbe53b2))
* **outbox:** name each wake kind once, and check the watchdog timeout fits its interval ([#441](https://github.com/quynhonsemiconductor/opshub/issues/441)) ([135d015](https://github.com/quynhonsemiconductor/opshub/commit/135d0153d251e0036b3a870d566628923ae04b3b))
* **platform:** adopt platform-http 4.3.0 and identity 8.2.0 where it loses nothing ([#364](https://github.com/quynhonsemiconductor/opshub/issues/364)) ([ce8637f](https://github.com/quynhonsemiconductor/opshub/commit/ce8637f007c0310d31317866e7322df0d9747f3f))
* **platform:** name the cache url VALKEY_URL, keeping REDIS_URL as a deprecated alias ([#400](https://github.com/quynhonsemiconductor/opshub/issues/400)) ([ef16233](https://github.com/quynhonsemiconductor/opshub/commit/ef162333487f43b06b65d54cf0ec06934d57bf03))


### 🔒 Security

* **ci:** arm gitleaks — the config was replacing the default ruleset ([#329](https://github.com/quynhonsemiconductor/opshub/issues/329)) ([63b175b](https://github.com/quynhonsemiconductor/opshub/commit/63b175b4950d48a411253d17e7a64c0b7307547e))
* **deps:** raise js-yaml to 4.3.2 and vitest to 4.1.11 for two 2026-09-08 advisories ([#327](https://github.com/quynhonsemiconductor/opshub/issues/327)) ([fd9f50d](https://github.com/quynhonsemiconductor/opshub/commit/fd9f50d9a1a43cf16ffe5fb0c8c5119d01a66c21))

## [0.3.1](https://github.com/quynhonsemiconductor/opshub/compare/v0.3.0...v0.3.1) (2026-09-08)


### ✨ Features

* **ci:** post a Grafana deploy annotation after a successful backend deploy ([#287](https://github.com/quynhonsemiconductor/opshub/issues/287)) ([1fe100b](https://github.com/quynhonsemiconductor/opshub/commit/1fe100b6b56ea8c396f27968baafbd194833d3f6))
* **infra:** add secrets-bundling plumbing, matching rally ([#266](https://github.com/quynhonsemiconductor/opshub/issues/266)) ([1384927](https://github.com/quynhonsemiconductor/opshub/commit/138492794af858532e7b92129b36ab13ab450743))
* **infra:** create the bundled secret for opshub develop ([#267](https://github.com/quynhonsemiconductor/opshub/issues/267)) ([9035833](https://github.com/quynhonsemiconductor/opshub/commit/903583394a563e418b6e226b0c701bc245e5a8a3))
* **infra:** move the api, worker and migrator to ARM64 Fargate ([#288](https://github.com/quynhonsemiconductor/opshub/issues/288)) ([86a30cd](https://github.com/quynhonsemiconductor/opshub/commit/86a30cd0de9b431b144583b204bea19abe1f152a))
* **infra:** port SES bounce/complaint feedback loop and log-group guard from rally ([#265](https://github.com/quynhonsemiconductor/opshub/issues/265)) ([bc2153c](https://github.com/quynhonsemiconductor/opshub/commit/bc2153c5733285c157be0185b55e188e83d95691))
* **infra:** turn on real SES sending for opshub develop ([#279](https://github.com/quynhonsemiconductor/opshub/issues/279)) ([014e0c5](https://github.com/quynhonsemiconductor/opshub/commit/014e0c5c8cc02c7c7b135d53fa4fef18757cfa97))
* **isms:** every register record can be corrected ([#250](https://github.com/quynhonsemiconductor/opshub/issues/250)) ([b88bec5](https://github.com/quynhonsemiconductor/opshub/commit/b88bec5cda8d743ef505b9f131dc8b27aa6a0eb6))
* make the notification settings true, and the motion real ([#252](https://github.com/quynhonsemiconductor/opshub/issues/252)) ([0ec7104](https://github.com/quynhonsemiconductor/opshub/commit/0ec710437adbf0b5acf0973d651a5c5fda35f9a9))
* **observability:** Grafana dashboards, alerts and SLO for opshub ([#257](https://github.com/quynhonsemiconductor/opshub/issues/257)) ([c630158](https://github.com/quynhonsemiconductor/opshub/commit/c6301584bb08f39e2d3a87ab1fe15296cdd616d2))
* **observability:** wire OTLP, log shipping, cache/CloudWatch alarms and auth.login metric ([#256](https://github.com/quynhonsemiconductor/opshub/issues/256)) ([6bc63fe](https://github.com/quynhonsemiconductor/opshub/commit/6bc63fec0807fc5c1bab3aa5ddd7a3842fbaf853))
* **web:** give the authenticated shell and dashboard the same design polish as the login page ([#289](https://github.com/quynhonsemiconductor/opshub/issues/289)) ([192f272](https://github.com/quynhonsemiconductor/opshub/commit/192f272f6d8388376c4f8846c7e631af7da4e493))
* **web:** give the authenticated shell and dashboard the same design polish as the login page ([#302](https://github.com/quynhonsemiconductor/opshub/issues/302)) ([9dfc259](https://github.com/quynhonsemiconductor/opshub/commit/9dfc259a43fcccdcf0f8639a5ac270e8a02d04b8))
* **web:** real visual identity on the login page ([#286](https://github.com/quynhonsemiconductor/opshub/issues/286)) ([934d8c8](https://github.com/quynhonsemiconductor/opshub/commit/934d8c85f75e0f883bef93febc0ed4925228d9af))
* **web:** roll out shadow, accent-secondary, display and fade-up tokens to shell primitives ([#290](https://github.com/quynhonsemiconductor/opshub/issues/290)) ([bb02a16](https://github.com/quynhonsemiconductor/opshub/commit/bb02a16696a7fe1b6b826511a4078027858cd7f8))
* **web:** roll out shadow, accent-secondary, display and fade-up tokens to shell primitives ([#303](https://github.com/quynhonsemiconductor/opshub/issues/303)) ([55ff73f](https://github.com/quynhonsemiconductor/opshub/commit/55ff73f67359441ebd1bb36be22dc6ebafeb7e98))
* **web:** smarter workforce logging, date-range filters, and a design-token pass ([#283](https://github.com/quynhonsemiconductor/opshub/issues/283)) ([1a8000d](https://github.com/quynhonsemiconductor/opshub/commit/1a8000d322082045c833ec96532efc787146fa8e))


### 🐛 Bug Fixes

* **api:** finish naming the person across ISMS, QMS, training and requests ([#244](https://github.com/quynhonsemiconductor/opshub/issues/244)) ([cfd8247](https://github.com/quynhonsemiconductor/opshub/commit/cfd82470d85387897018392ee43c4725adc43ee8))
* **ci:** bump reusable-workflow pins to v1.10.0, add agent-forge test-guard ([#269](https://github.com/quynhonsemiconductor/opshub/issues/269)) ([a844449](https://github.com/quynhonsemiconductor/opshub/commit/a8444491eb6f736d580db12ad2645213a505de3a))
* **ci:** make the tag deploy wait for the develop deploy of the same commit ([#285](https://github.com/quynhonsemiconductor/opshub/issues/285)) ([eb9f8fc](https://github.com/quynhonsemiconductor/opshub/commit/eb9f8fccefb01916a549de32586fccbdf4d76279))
* **ci:** map GRAFANA_ALERTS_TOKEN into infra-apply and infra-plan ([#258](https://github.com/quynhonsemiconductor/opshub/issues/258)) ([48e4fbe](https://github.com/quynhonsemiconductor/opshub/commit/48e4fbe75a8e449dddf856b63bcbeb8b627f10d1))
* close the audit findings — rules that existed, were documented, and did not apply ([#254](https://github.com/quynhonsemiconductor/opshub/issues/254)) ([aac6f62](https://github.com/quynhonsemiconductor/opshub/commit/aac6f62b8f7b111a57ad35119cefecfb6ef7c2fa))
* close the go-live blockers — journeys that could not be completed at all ([#248](https://github.com/quynhonsemiconductor/opshub/issues/248)) ([093d484](https://github.com/quynhonsemiconductor/opshub/commit/093d4849ebf26d1f266ef41651e90c88b69577d4))
* close two data-protection holes, stop failure reading as reassurance, and unstall the relay ([#246](https://github.com/quynhonsemiconductor/opshub/issues/246)) ([a878c4e](https://github.com/quynhonsemiconductor/opshub/commit/a878c4e2acd5869f97200a511b05f8eee70ad688))
* **config:** treat empty MAIL_FROM_EMAIL/MAIL_REPLY_TO as unset ([#277](https://github.com/quynhonsemiconductor/opshub/issues/277)) ([afa165e](https://github.com/quynhonsemiconductor/opshub/commit/afa165e6948ce83b7dee0f7b92d4f7e0ad503843))
* **deps:** restore dependabot npm updates ([#319](https://github.com/quynhonsemiconductor/opshub/issues/319)) ([937fe35](https://github.com/quynhonsemiconductor/opshub/commit/937fe35fcc55756e9721dfa14f6e8831e7375d7a))
* gate every write surface on the permission its route requires ([#251](https://github.com/quynhonsemiconductor/opshub/issues/251)) ([0a6bf72](https://github.com/quynhonsemiconductor/opshub/commit/0a6bf72d224687d96794876e07966ae6544ea16b))
* **identity:** log real cause of BFF callback failures server-side ([#280](https://github.com/quynhonsemiconductor/opshub/issues/280)) ([1ec9873](https://github.com/quynhonsemiconductor/opshub/commit/1ec98734255c8b3e3d79ed5640270629e4769d02))
* **infra:** bump ecs-service to v2.3.2 for the task-role KMS decrypt fix ([#270](https://github.com/quynhonsemiconductor/opshub/issues/270)) ([52f102f](https://github.com/quynhonsemiconductor/opshub/commit/52f102fd92a42f590b70ac6e180ed4fc1a8d1bac))
* **infra:** bump to the module versions that unblock a first-ever apply ([#260](https://github.com/quynhonsemiconductor/opshub/issues/260)) ([e9261d9](https://github.com/quynhonsemiconductor/opshub/commit/e9261d911ff1123fb23c8f43229f98f70375e0a6))
* **infra:** give opshub a real, Terraform-managed Cloudflare Tunnel ([#261](https://github.com/quynhonsemiconductor/opshub/issues/261)) ([d24a5e6](https://github.com/quynhonsemiconductor/opshub/commit/d24a5e6138c28da11b155ea223b7abc3b160b003))
* **infra:** grant the api/worker execution roles read access to their own secrets ([#268](https://github.com/quynhonsemiconductor/opshub/issues/268)) ([fdda923](https://github.com/quynhonsemiconductor/opshub/commit/fdda9238a76f85a8082bb4d46847f49ebe4e9068))
* **infra:** guard alb_dns_name output like rally's copy already does ([#259](https://github.com/quynhonsemiconductor/opshub/issues/259)) ([47b5894](https://github.com/quynhonsemiconductor/opshub/commit/47b5894a8b814caab9d40c36bdfd5ff5edff86f4))
* **infra:** import the real DNS CNAME record too, looked up dynamically ([#263](https://github.com/quynhonsemiconductor/opshub/issues/263)) ([cf11200](https://github.com/quynhonsemiconductor/opshub/commit/cf1120025e97ab4ba503a20a070c6ea71c68522b))
* **infra:** import the real Pages custom domain attachment too ([#262](https://github.com/quynhonsemiconductor/opshub/issues/262)) ([7246244](https://github.com/quynhonsemiconductor/opshub/commit/7246244ca33577e373749d56d8b559909613fbe8))
* **infra:** wire entra-client-secret and graph-client-secret into opshub develop ([#281](https://github.com/quynhonsemiconductor/opshub/issues/281)) ([5b51e66](https://github.com/quynhonsemiconductor/opshub/commit/5b51e66a94dc3d8503a1cdceab7d7d95df9dafaf))
* make the five "checked by the service" document references actually checked ([#255](https://github.com/quynhonsemiconductor/opshub/issues/255)) ([f489927](https://github.com/quynhonsemiconductor/opshub/commit/f48992787a3713f5721dd5687255c7a11141c7b5))
* **requests:** tell the people who can decide a request that it is waiting ([#253](https://github.com/quynhonsemiconductor/opshub/issues/253)) ([346c19b](https://github.com/quynhonsemiconductor/opshub/commit/346c19b84e6ebfb65fc73da634e654af95aee73a))
* volume-gate the low-traffic latency alerts, warm the DB pool, bound the interactive S3 budget ([#282](https://github.com/quynhonsemiconductor/opshub/issues/282)) ([14dcdc5](https://github.com/quynhonsemiconductor/opshub/commit/14dcdc5c8b9a70fe21f7aa0c1bc35e216644cef0))
* **web:** give empty-state CTAs their own name, distinct from the toolbar button ([#284](https://github.com/quynhonsemiconductor/opshub/issues/284)) ([5b5be38](https://github.com/quynhonsemiconductor/opshub/commit/5b5be38399d43f6b11c32d41fcacf0146fb1d0fc))
* **web:** notification bell used a nonexistent bg-accent-muted0 class ([#291](https://github.com/quynhonsemiconductor/opshub/issues/291)) ([7447b81](https://github.com/quynhonsemiconductor/opshub/commit/7447b81d357592f9a7b8b8a1d24c69b15594897d))


### ♻️ Refactors

* **platform:** source runtime primitives from @quynhonsemiconductor/platform-runtime ([#304](https://github.com/quynhonsemiconductor/opshub/issues/304)) ([2a32d58](https://github.com/quynhonsemiconductor/opshub/commit/2a32d58dbfc325cf6cad1a7e703b0265ff1d5850))

## [0.3.0](https://github.com/QNSC-VN/opshub/compare/v0.2.1...v0.3.0) (2026-08-21)


### ⚠ BREAKING CHANGES

* **http:** validate every uuid path parameter, and ratchet it ([#125](https://github.com/QNSC-VN/opshub/issues/125))
* **platform:** remove the unconsumed domain-event outbox leg ([#123](https://github.com/QNSC-VN/opshub/issues/123))

### ✨ Features

* **api:** make idempotent retries reachable, and make them a guarantee ([#221](https://github.com/QNSC-VN/opshub/issues/221)) ([5de1228](https://github.com/QNSC-VN/opshub/commit/5de1228dcbb9ab35ff56e5719d2c857d573f1242))
* **api:** send mail through SES, and grant the permission that makes it work ([#232](https://github.com/QNSC-VN/opshub/issues/232)) ([721e342](https://github.com/QNSC-VN/opshub/commit/721e342d5199b34f2bfa806fe1d1f07242a1954b))
* **dev:** add LocalStack to the dev stack so SQS and uploads run locally ([#120](https://github.com/QNSC-VN/opshub/issues/120)) ([ac9c80e](https://github.com/QNSC-VN/opshub/commit/ac9c80e74dfac5dc501c9a89f1d561c548d3d4f1))
* **documents:** controlled documents — the shared primitive for ISMS, QMS and EMS ([#138](https://github.com/QNSC-VN/opshub/issues/138)) ([6832b1c](https://github.com/QNSC-VN/opshub/commit/6832b1cf1072de7f467fff199c96b01404b7fa88))
* **email:** SES transport and the bounce feedback loop, ported from rally ([#237](https://github.com/QNSC-VN/opshub/issues/237)) ([5040902](https://github.com/QNSC-VN/opshub/commit/5040902bfa31beed644e142333a110d37121ab15))
* **ems:** employment contracts — terms, lifecycle, renewal and expiry ([#140](https://github.com/QNSC-VN/opshub/issues/140)) ([10fe7e8](https://github.com/QNSC-VN/opshub/commit/10fe7e8703b5ef6f3e363d471bbb860397867952))
* **ems:** performance reviews — cycles, weighted goals, calibrated sign-off ([#153](https://github.com/QNSC-VN/opshub/issues/153)) ([003246a](https://github.com/QNSC-VN/opshub/commit/003246adbcae8b6668d79fac2fc72e40488969a9))
* **ems:** positions, approved headcount and assignment history ([#139](https://github.com/QNSC-VN/opshub/issues/139)) ([923b079](https://github.com/QNSC-VN/opshub/commit/923b0793646e8b934d239cfc14fd82dab9815250))
* **ems:** training records, and the shared upload plumbing they need ([#141](https://github.com/QNSC-VN/opshub/issues/141)) ([505df76](https://github.com/QNSC-VN/opshub/commit/505df7630c7643022e17ef3d07946a7860cb3937))
* **infra:** wake develop on a weekday morning, and make the guards actually fail ([#116](https://github.com/QNSC-VN/opshub/issues/116)) ([638a360](https://github.com/QNSC-VN/opshub/commit/638a360e883c0e6e9a92ea2afd2d2c50729ec2d8))
* **infra:** watch tunnelled ingress from outside aws, gated on the idle posture ([#117](https://github.com/QNSC-VN/opshub/issues/117)) ([7612c98](https://github.com/QNSC-VN/opshub/commit/7612c981cc10f7b014bb111d42a36abc399b1aef))
* **isms:** control catalogue, Statement of Applicability, risk coverage ([#143](https://github.com/QNSC-VN/opshub/issues/143)) ([207287d](https://github.com/QNSC-VN/opshub/commit/207287d754c2d542f68afed03713753b3ad0ca7b))
* **isms:** information asset register, classification history, device holdings ([#145](https://github.com/QNSC-VN/opshub/issues/145)) ([9b8232d](https://github.com/QNSC-VN/opshub/commit/9b8232dfb32a0fa8428f26b555abf428a7514c61))
* **isms:** remind owners when a periodic review comes due ([#175](https://github.com/QNSC-VN/opshub/issues/175)) ([908822f](https://github.com/QNSC-VN/opshub/commit/908822f62a5c3bffb8cc6bb3068709c7a25053fd))
* **isms:** risk register with generated scoring and acceptance sign-off ([#142](https://github.com/QNSC-VN/opshub/issues/142)) ([5b415fe](https://github.com/QNSC-VN/opshub/commit/5b415fe30d7cc1016a0cbffd2dd2a958f0e1ec5c))
* **isms:** security incidents, append-only timeline, 72-hour breach clock ([#144](https://github.com/QNSC-VN/opshub/issues/144)) ([c9b669b](https://github.com/QNSC-VN/opshub/commit/c9b669b073832fb8de5af1e42dc9323edca41cbe))
* **isms:** vendor risk — criticality tiers, due diligence, go-live gate ([#146](https://github.com/QNSC-VN/opshub/issues/146)) ([aedc794](https://github.com/QNSC-VN/opshub/commit/aedc794b3cc2b3625dea90f0e78d8737164490d5))
* **notifications:** deliver the email half, which had never run ([#208](https://github.com/QNSC-VN/opshub/issues/208)) ([f908fad](https://github.com/QNSC-VN/opshub/commit/f908fad15b01d3eea4c646738065d49279544c01))
* **observability:** adopt rally's telemetry and alarms, with the sampler actually applied ([#110](https://github.com/QNSC-VN/opshub/issues/110)) ([e0f475b](https://github.com/QNSC-VN/opshub/commit/e0f475b2596608a6c64ad3692243ba0a70e25763))
* **observability:** alarm when a security control fails open ([#112](https://github.com/QNSC-VN/opshub/issues/112)) ([ecac793](https://github.com/QNSC-VN/opshub/commit/ecac793207ce758cdb4537894434c9e3540c3c95))
* **observability:** local OTLP collector, and make OTEL_ENABLED actually work ([#127](https://github.com/QNSC-VN/opshub/issues/127)) ([8ad9f14](https://github.com/QNSC-VN/opshub/commit/8ad9f149bd89173f64e27ae424a939c45f5d19aa))
* **platform:** port rally's relay backoff, metrics and seed floor ([#122](https://github.com/QNSC-VN/opshub/issues/122)) ([29185cc](https://github.com/QNSC-VN/opshub/commit/29185cc10a654373ef8373a996f041b8b7f9c0bc))
* **qms:** internal audit programme, rosters, and auditor impartiality ([#149](https://github.com/QNSC-VN/opshub/issues/149)) ([0e1004b](https://github.com/QNSC-VN/opshub/commit/0e1004b6496ebc0df28803a9b51457df507bb083))
* **qms:** management review with a composed, frozen §9.3.2 agenda ([#150](https://github.com/QNSC-VN/opshub/issues/150)) ([25a2fcc](https://github.com/QNSC-VN/opshub/commit/25a2fcc3742d24fb106ed66bb1d4cef9249ac25f))
* **qms:** non-conformance register and CAPA with a closure gate ([#148](https://github.com/QNSC-VN/opshub/issues/148)) ([0d7a3bd](https://github.com/QNSC-VN/opshub/commit/0d7a3bd1e67aa2041ad891f8536cac50c2dfc733))
* **scheduling:** run every scheduled job on exactly one pod ([#129](https://github.com/QNSC-VN/opshub/issues/129)) ([52f5ac8](https://github.com/QNSC-VN/opshub/commit/52f5ac802f67c63b1bfaa5e8b6d807bf9ef859e2))
* **tms:** accrue leave over the year and carry unused days forward ([#151](https://github.com/QNSC-VN/opshub/issues/151)) ([27f07bf](https://github.com/QNSC-VN/opshub/commit/27f07bf35e1ba0dd6449c75eb526c60ddaa4ae74))
* **tms:** part-day leave, in halves the balance already understood ([#152](https://github.com/QNSC-VN/opshub/issues/152)) ([037e8b4](https://github.com/QNSC-VN/opshub/commit/037e8b4864f1d8fafc9d03e93ba958321a9653a1))
* **web:** add Checkbox to the kit, and give the drifted copy its focus ring back ([#215](https://github.com/QNSC-VN/opshub/issues/215)) ([4351dfa](https://github.com/QNSC-VN/opshub/commit/4351dfaccef20f4a2c7a756e0aed0de9d1428ca0))
* **web:** contract renewal, employment history, and a modal stacking fix ([#181](https://github.com/QNSC-VN/opshub/issues/181)) ([60d8263](https://github.com/QNSC-VN/opshub/commit/60d8263c0ceeedd7260dd30edbfafd85d402cdad))
* **web:** information-asset device links, retirement, and the lost-laptop report ([#182](https://github.com/QNSC-VN/opshub/issues/182)) ([858a278](https://github.com/QNSC-VN/opshub/commit/858a278fa44322378809487d74825bf927dcf6cf))
* **web:** internal audits and management reviews — QMS complete ([#172](https://github.com/QNSC-VN/opshub/issues/172)) ([f91d23d](https://github.com/QNSC-VN/opshub/commit/f91d23dbdb44b3db8b731f315977e3218a456152))
* **web:** ISMS risk register and Statement of Applicability ([#166](https://github.com/QNSC-VN/opshub/issues/166)) ([816cbd9](https://github.com/QNSC-VN/opshub/commit/816cbd96f3db0607a671a7a961ef4476703855ce))
* **web:** leave balances, the holiday calendar and accrual policies ([#177](https://github.com/QNSC-VN/opshub/issues/177)) ([ac791dc](https://github.com/QNSC-VN/opshub/commit/ac791dc20464d6cd869609e89277caec207cc445))
* **web:** licence seat management ([#179](https://github.com/QNSC-VN/opshub/issues/179)) ([7ee2eda](https://github.com/QNSC-VN/opshub/commit/7ee2eda7926dc48f2aefadce9176e0ec6b4f80dc))
* **web:** link register risks to a supplier, searched by the server ([#191](https://github.com/QNSC-VN/opshub/issues/191)) ([ba901f4](https://github.com/QNSC-VN/opshub/commit/ba901f40799ac9fdf3e461d65e0ebc57a9f74a74))
* **web:** make a software listing changeable, and findable ([#194](https://github.com/QNSC-VN/opshub/issues/194)) ([53b96fb](https://github.com/QNSC-VN/opshub/commit/53b96fbb1d6d3b2836edcde6a86883b1358b45b4))
* **web:** non-conformance register and CAPA loop ([#169](https://github.com/QNSC-VN/opshub/issues/169)) ([c61beb3](https://github.com/QNSC-VN/opshub/commit/c61beb3de0dcde41b6431a3b7b1926b272dbc375))
* **web:** one DataTable, one list layout, and the paging the SPA never had ([#154](https://github.com/QNSC-VN/opshub/issues/154)) ([035ff20](https://github.com/QNSC-VN/opshub/commit/035ff20b9c1c0ce25b7dd6af877a1a6e80a0e11a))
* **web:** performance review screens — and a 429 that said only "Error" ([#165](https://github.com/QNSC-VN/opshub/issues/165)) ([a896e08](https://github.com/QNSC-VN/opshub/commit/a896e089a2d0028320c597b26200dc034b1ccadf))
* **web:** positions and contracts screens, and the API's own error messages ([#163](https://github.com/QNSC-VN/opshub/issues/163)) ([dc298f9](https://github.com/QNSC-VN/opshub/commit/dc298f98de7f072e3cc67b885d91035417a90026))
* **web:** Shadow IT detections, and the DTOs that made them reachable ([#180](https://github.com/QNSC-VN/opshub/issues/180)) ([a1d6934](https://github.com/QNSC-VN/opshub/commit/a1d69342a8fcf44241176b51447cda6d00b6b5bb))
* **web:** the asset lifecycle and its custody history ([#178](https://github.com/QNSC-VN/opshub/issues/178)) ([30172c5](https://github.com/QNSC-VN/opshub/commit/30172c5f8688092587056027cd738319739f721f))
* **web:** the controlled-document library ([#176](https://github.com/QNSC-VN/opshub/issues/176)) ([0f6d003](https://github.com/QNSC-VN/opshub/commit/0f6d003dbd37ff614b72872c0d46ae6a3e8f4ba2))
* **web:** the incident register, its timeline and the breach clock ([#167](https://github.com/QNSC-VN/opshub/issues/167)) ([0b527aa](https://github.com/QNSC-VN/opshub/commit/0b527aa1f73595286341e5e57c424d0a9eefb0ba))
* **web:** the information-asset and supplier registers — ISMS complete ([#168](https://github.com/QNSC-VN/opshub/issues/168)) ([cd3c583](https://github.com/QNSC-VN/opshub/commit/cd3c58397606f60a2f092e8df1b8398dd841b1ad))
* **web:** the privileged access you hold, and revoking it early ([#192](https://github.com/QNSC-VN/opshub/issues/192)) ([f51e724](https://github.com/QNSC-VN/opshub/commit/f51e724547aca8f160b9eddaa83cd8a6dc15eb2b))
* **web:** the request discussion, and withdrawing a request ([#183](https://github.com/QNSC-VN/opshub/issues/183)) ([b15b2c2](https://github.com/QNSC-VN/opshub/commit/b15b2c2e6c31ea05491ac145821e9f00bccc7086))
* **web:** the request mix report, and six report panels that were 422ing ([#197](https://github.com/QNSC-VN/opshub/issues/197)) ([76f6892](https://github.com/QNSC-VN/opshub/commit/76f689264b6528e1cc5d6d6d05126f8587be94ca))
* **web:** training and competency screens — and four dead upload paths ([#164](https://github.com/QNSC-VN/opshub/issues/164)) ([90ba390](https://github.com/QNSC-VN/opshub/commit/90ba390777eed8eb029c686ebbb215ad370903d6))
* **web:** your own roles and contracts, and a role history that names the role ([#195](https://github.com/QNSC-VN/opshub/issues/195)) ([3ccd2a6](https://github.com/QNSC-VN/opshub/commit/3ccd2a6297aac0e8bfc3328f18eb87cca5de3e89))
* **workforce:** leave entitlement, balances and a holiday calendar ([#137](https://github.com/QNSC-VN/opshub/issues/137)) ([331b8ed](https://github.com/QNSC-VN/opshub/commit/331b8ed1ca9a62131561714a8f4bedcfcd766e5f))


### 🐛 Bug Fixes

* **access-requests:** stop 500ing on approval, and stop losing notifications ([#124](https://github.com/QNSC-VN/opshub/issues/124)) ([8a3aa18](https://github.com/QNSC-VN/opshub/commit/8a3aa181ac409e9e82855005ecb22753026b6a43))
* **ai:** enforce authorization per tool, not per route ([#200](https://github.com/QNSC-VN/opshub/issues/200)) ([2e43919](https://github.com/QNSC-VN/opshub/commit/2e4391908f0770ebaf51dbac0ffe6b4fe22eb631))
* **api:** key the rate limiter on the caller, not on the network ([#224](https://github.com/QNSC-VN/opshub/issues/224)) ([bc11571](https://github.com/QNSC-VN/opshub/commit/bc115718fc0996ab7e55166f3ee0d47fae874e3c))
* **api:** let a refusal say which refusal it is, and give it the right status ([#220](https://github.com/QNSC-VN/opshub/issues/220)) ([3747feb](https://github.com/QNSC-VN/opshub/commit/3747feb59da13a75e419cacc3735158cf8daff6a))
* **api:** name the person on reviews, position history and asset custody ([#236](https://github.com/QNSC-VN/opshub/issues/236)) ([ea1c319](https://github.com/QNSC-VN/opshub/commit/ea1c3197bb6471e8928f00671c2b47a87b52124d))
* **api:** name the person, not the uuid ([#235](https://github.com/QNSC-VN/opshub/issues/235)) ([06f47fa](https://github.com/QNSC-VN/opshub/commit/06f47fa84f513c01cf337ec386e91f55b571d50d))
* **api:** page the coverage report instead of silently cutting it at 500 ([#222](https://github.com/QNSC-VN/opshub/issues/222)) ([3a39936](https://github.com/QNSC-VN/opshub/commit/3a399366c09a99a2a7037da3f469975b88b771bf))
* **api:** stop webhook subscriptions from aiming at the VPC ([#231](https://github.com/QNSC-VN/opshub/issues/231)) ([b7a23f1](https://github.com/QNSC-VN/opshub/commit/b7a23f1b430c5ee0eee7afc451a4d67ace119b0d))
* **api:** wire the two env variables that nothing read ([#229](https://github.com/QNSC-VN/opshub/issues/229)) ([2a5dac2](https://github.com/QNSC-VN/opshub/commit/2a5dac2cbb144d13ac23223fec9d546cc0a82edd))
* **audit:** make every service audit write atomic with its mutation ([#174](https://github.com/QNSC-VN/opshub/issues/174)) ([dd85af3](https://github.com/QNSC-VN/opshub/commit/dd85af35616dba0a9562b1088acb6106782c80b3))
* **audit:** stop recording every action twice, and make the entry atomic with the change ([#130](https://github.com/QNSC-VN/opshub/issues/130)) ([e761571](https://github.com/QNSC-VN/opshub/commit/e761571f1fc7647ac5bd4c83b387ac2f79de26f8))
* **authz:** bind the row on three routes whose siblings already did, and count the rest ([#202](https://github.com/QNSC-VN/opshub/issues/202)) ([7e4a158](https://github.com/QNSC-VN/opshub/commit/7e4a1588b5d93afbc33e0ee1d9980f30c416b328))
* **authz:** make an unreachable permission impossible to ship ([#199](https://github.com/QNSC-VN/opshub/issues/199)) ([0bf99f4](https://github.com/QNSC-VN/opshub/commit/0bf99f491c6a565859eec4f911389dc3323736a3))
* **authz:** the boot audit's route floor is ZERO, not the full route count ([#134](https://github.com/QNSC-VN/opshub/issues/134)) ([d27ab9c](https://github.com/QNSC-VN/opshub/commit/d27ab9c40d97ae7eb6b6436c1c8f48a982b61456))
* **ci:** stop dependabot updating terraform providers ([#173](https://github.com/QNSC-VN/opshub/issues/173)) ([0a6adbc](https://github.com/QNSC-VN/opshub/commit/0a6adbcd31bdc9453986e2a572d1ce53c029ab4c))
* **db:** make every ORDER BY a total order, and ratchet it at zero ([#108](https://github.com/QNSC-VN/opshub/issues/108)) ([2cec3b3](https://github.com/QNSC-VN/opshub/commit/2cec3b30ccf9a8127ac2d3f29720d482defe28b1))
* **deploy:** correct the container health check path and drop a lifecycle rule that matched nothing ([#209](https://github.com/QNSC-VN/opshub/issues/209)) ([f825824](https://github.com/QNSC-VN/opshub/commit/f82582493f7e972d2298498679c3650197928480))
* **deps:** pin nanoid &gt;= 3.3.17 for GHSA-2v37-7h3g-55p8 ([#131](https://github.com/QNSC-VN/opshub/issues/131)) ([9ea4e3e](https://github.com/QNSC-VN/opshub/commit/9ea4e3e01f098e0f1b5b2815fe8cfd82ac1d69e7))
* **deps:** pin nanoid to the version that actually fixes GHSA-2v37-7h3g-55p8 ([#184](https://github.com/QNSC-VN/opshub/issues/184)) ([c9ffc31](https://github.com/QNSC-VN/opshub/commit/c9ffc31926bd84e42b5891ed80fbbe3aee0a2a8b))
* **deps:** raise the js-yaml floor to 4.3.1 for CVE-2026-59870 ([#126](https://github.com/QNSC-VN/opshub/issues/126)) ([df79df5](https://github.com/QNSC-VN/opshub/commit/df79df528116eab7ea471d6966d7659410ff66b1))
* **email:** refuse to boot without a sender, and use the SDK's idempotency key ([#211](https://github.com/QNSC-VN/opshub/issues/211)) ([ef214b9](https://github.com/QNSC-VN/opshub/commit/ef214b91a60cd63a3dc7361f457ed2a4a00c8ed2))
* **http:** validate every uuid path parameter, and ratchet it ([#125](https://github.com/QNSC-VN/opshub/issues/125)) ([07961ff](https://github.com/QNSC-VN/opshub/commit/07961ff0c16913fc215a419e4002fe28b998ecbe))
* **infra:** make the db-pool guard fail instead of warn ([#118](https://github.com/QNSC-VN/opshub/issues/118)) ([525e52b](https://github.com/QNSC-VN/opshub/commit/525e52bced1717bfd312d499ae5cee619f6ef42e))
* **infra:** refuse autoscaling with a floor of zero ([#119](https://github.com/QNSC-VN/opshub/issues/119)) ([01c80f2](https://github.com/QNSC-VN/opshub/commit/01c80f232c9bb00d20c8385c816ddceac12fc603))
* **license:** order the one paged read that had no ORDER BY, and teach the ratchet to see it ([#203](https://github.com/QNSC-VN/opshub/issues/203)) ([f136455](https://github.com/QNSC-VN/opshub/commit/f136455ef960da933c6a510b684393424b753d20))
* **requests:** name the requester on inbox rows ([#233](https://github.com/QNSC-VN/opshub/issues/233)) ([e7bca3e](https://github.com/QNSC-VN/opshub/commit/e7bca3e1552fd61ad53ea838e210f435c40a4dc2))
* **search:** treat the user's search term as text, not as a LIKE pattern ([#206](https://github.com/QNSC-VN/opshub/issues/206)) ([14bbe48](https://github.com/QNSC-VN/opshub/commit/14bbe48bd46e202eeaf9b6264005432ca96db34d))
* **web:** announce form failures, instead of only displaying them ([#212](https://github.com/QNSC-VN/opshub/issues/212)) ([efa88e7](https://github.com/QNSC-VN/opshub/commit/efa88e790837b90ee01c6c8adad9381b7081fec4))
* **web:** debounce the palette's searches, layer it above dialogs, and gate three pages' writes ([#210](https://github.com/QNSC-VN/opshub/issues/210)) ([6b61ba8](https://github.com/QNSC-VN/opshub/commit/6b61ba84faadcdb95a69e706a9193ff4ff718b87))
* **web:** finish the focus-ring sweep, and fix the scanner that under-counted it ([#227](https://github.com/QNSC-VN/opshub/issues/227)) ([1d9992c](https://github.com/QNSC-VN/opshub/commit/1d9992c12f4caf1101f74052f353f91662f4af72))
* **web:** finops read `total` from the wrong place, so its pager never appeared ([#160](https://github.com/QNSC-VN/opshub/issues/160)) ([aec0b04](https://github.com/QNSC-VN/opshub/commit/aec0b04f9240c63c811afcde8cfed38a04ac5bba))
* **web:** give the shell's own buttons a focus ring ([#226](https://github.com/QNSC-VN/opshub/issues/226)) ([57ee6e0](https://github.com/QNSC-VN/opshub/commit/57ee6e0054f5296fb32f7345e43ccabc984e7fb1))
* **web:** give the type scale its bottom step, so 10px stops being an arbitrary value ([#228](https://github.com/QNSC-VN/opshub/issues/228)) ([c58e8b7](https://github.com/QNSC-VN/opshub/commit/c58e8b72b03dc84e53e04568445aba3173296079))
* **webhooks:** stop deliveries outliving the subscription they were queued for ([#205](https://github.com/QNSC-VN/opshub/issues/205)) ([b7e429c](https://github.com/QNSC-VN/opshub/commit/b7e429c455074dd8d1b14bf4ad46412bdd45af27))
* **web:** read attachments back, so an upload survives a reload ([#193](https://github.com/QNSC-VN/opshub/issues/193)) ([ede02ee](https://github.com/QNSC-VN/opshub/commit/ede02ee8cc2338c9c2aec3faec868172f3a0aa4c))
* **web:** seed the unread badge, and let a failed webhook delivery be retried ([#196](https://github.com/QNSC-VN/opshub/issues/196)) ([1931336](https://github.com/QNSC-VN/opshub/commit/1931336723a3fc48b0894fb989c844a7dbc8c473))
* **web:** stop panels reporting a failed load as an absence ([#213](https://github.com/QNSC-VN/opshub/issues/213)) ([751ed61](https://github.com/QNSC-VN/opshub/commit/751ed61f089f8bf3ac7f66240971c7ce31f2ccb6))
* **web:** type the SPA/API seams, so a value the API rejects stops compiling ([#207](https://github.com/QNSC-VN/opshub/issues/207)) ([be0c20f](https://github.com/QNSC-VN/opshub/commit/be0c20f5e1d062d8c7c7058feb7e67b5607488c2))
* **worker:** put the outbox relay on the shared base and alarm on dead letters ([#121](https://github.com/QNSC-VN/opshub/issues/121)) ([461f720](https://github.com/QNSC-VN/opshub/commit/461f720ab9390d39f60f3fc6ffeb28188d6b43dd))
* **workforce:** audit every privilege offboarding removes, and drop the permission cache ([#201](https://github.com/QNSC-VN/opshub/issues/201)) ([1417d14](https://github.com/QNSC-VN/opshub/commit/1417d142858868837a5fbef0dc851262c67d1e1f))
* **workforce:** audit the leave and overtime decisions, including the ones nobody made ([#204](https://github.com/QNSC-VN/opshub/issues/204)) ([3168604](https://github.com/QNSC-VN/opshub/commit/316860497ff811a97775d96b8c47def1620d3237))


### ⚡ Performance

* **web:** hand the bootstrap's answer to the query cache instead of fetching it twice ([#223](https://github.com/QNSC-VN/opshub/issues/223)) ([9fd0c9e](https://github.com/QNSC-VN/opshub/commit/9fd0c9ec22aaa571757a1595fc9bb343bed0b6dc))


### ♻️ Refactors

* **api:** give the employee-reference check a name, and one query ([#217](https://github.com/QNSC-VN/opshub/issues/217)) ([3f1a0cd](https://github.com/QNSC-VN/opshub/commit/3f1a0cd196040242cc33cd3cb4415455f7f52c2b))
* **api:** one Graph client, built once, instead of five built per call ([#218](https://github.com/QNSC-VN/opshub/issues/218)) ([ac43049](https://github.com/QNSC-VN/opshub/commit/ac43049295e3c4d01bf4853090bc26305c473f17))
* consolidate seven duplicated primitives found by a codebase audit ([#147](https://github.com/QNSC-VN/opshub/issues/147)) ([a5b8bd2](https://github.com/QNSC-VN/opshub/commit/a5b8bd2a79bf2885e698faf731def54667d8bc4d))
* **observability:** take the OTel bootstrap and Span from the shared package ([#114](https://github.com/QNSC-VN/opshub/issues/114)) ([871fee2](https://github.com/QNSC-VN/opshub/commit/871fee2110ad7ccd71eb2c0eea11730409db985d))
* **platform:** remove the unconsumed domain-event outbox leg ([#123](https://github.com/QNSC-VN/opshub/issues/123)) ([92c3f4c](https://github.com/QNSC-VN/opshub/commit/92c3f4c4aa0d8506f460c6e3037c9ddc3527180d))
* **web:** a real UI kit, and two screens moved onto it ([#155](https://github.com/QNSC-VN/opshub/issues/155)) ([2b7b4ff](https://github.com/QNSC-VN/opshub/commit/2b7b4ffcd4913776268ec8a486fb0bc28bd92580))
* **web:** access control onto the kit, and a row stops being a button ([#158](https://github.com/QNSC-VN/opshub/issues/158)) ([b9a01c6](https://github.com/QNSC-VN/opshub/commit/b9a01c610eca0313b92a74e0e2305b3bf22ade40))
* **web:** assets, inbox and catalog onto the kit — and two more API mismatches ([#161](https://github.com/QNSC-VN/opshub/issues/161)) ([a4edac9](https://github.com/QNSC-VN/opshub/commit/a4edac9d08481aa0c49f1e56b74716a3ad415790))
* **web:** let FormActions say the caller's verb, and retire nineteen hand-rolled footers ([#216](https://github.com/QNSC-VN/opshub/issues/216)) ([4efe800](https://github.com/QNSC-VN/opshub/commit/4efe800f52db7b4c5464fdb059bce9d9bc287184))
* **web:** name the cache tiers, and retire the last two hand-formatted dates ([#219](https://github.com/QNSC-VN/opshub/issues/219)) ([1f9b7e4](https://github.com/QNSC-VN/opshub/commit/1f9b7e46e084e35e745766b90896638c100951a6))
* **web:** people onto the kit, and its wizard gets real radios ([#157](https://github.com/QNSC-VN/opshub/issues/157)) ([105afbf](https://github.com/QNSC-VN/opshub/commit/105afbfe4a3a9863b4e576683ca5de8bd6d5971c))
* **web:** the dashboard's seven personas become one table of data ([#159](https://github.com/QNSC-VN/opshub/issues/159)) ([003c964](https://github.com/QNSC-VN/opshub/commit/003c96482a601d4efcaed1f41d3f52284f60b9ee))
* **web:** the last five screens — and the dialog ratchet reaches zero ([#162](https://github.com/QNSC-VN/opshub/issues/162)) ([1394d71](https://github.com/QNSC-VN/opshub/commit/1394d710a703e315254b991ec1f906b7a604c2e7))
* **web:** workforce onto the kit, and a closed drawer stops being a dialog ([#156](https://github.com/QNSC-VN/opshub/issues/156)) ([04268a8](https://github.com/QNSC-VN/opshub/commit/04268a83ef8e583858cdd1d04d68aa6c99229352))


### 🔒 Security

* **authz:** deny routes that declare no authorization, and refuse to boot on one ([#132](https://github.com/QNSC-VN/opshub/issues/132)) ([70427eb](https://github.com/QNSC-VN/opshub/commit/70427eb3b2bebd122206b28b15fb1c67ddb5e4e9))
* **authz:** narrow request and access-request reads to the caller ([#133](https://github.com/QNSC-VN/opshub/issues/133)) ([ddf242f](https://github.com/QNSC-VN/opshub/commit/ddf242f2ea042cb9d9bb9c6c9ee3aaeb17c262af))

## [0.2.1](https://github.com/QNSC-VN/opshub/compare/v0.2.0...v0.2.1) (2026-08-05)


### ✨ Features

* **db:** least-privilege postgres roles, created but not yet cut over ([#106](https://github.com/QNSC-VN/opshub/issues/106)) ([f010fb3](https://github.com/QNSC-VN/opshub/commit/f010fb3d2260036de62a24758dcc9da16e941705))


### 🐛 Bug Fixes

* **workforce:** scope HR record reads and self-service transitions to the caller ([#105](https://github.com/QNSC-VN/opshub/issues/105)) ([fceac07](https://github.com/QNSC-VN/opshub/commit/fceac07ae619845eddc9c575eb74cade27017ab1))

## [0.2.0](https://github.com/QNSC-VN/opshub/compare/v0.1.1...v0.2.0) (2026-08-05)


### ⚠ BREAKING CHANGES

* **infra:** tunnel ingress, idling, and floors that let an environment park ([#97](https://github.com/QNSC-VN/opshub/issues/97))
* **web:** sign in through the BFF, and hold no token in the browser ([#88](https://github.com/QNSC-VN/opshub/issues/88))
* **db,infra:** compose the DB URL from parts, derive the JWT public key ([#82](https://github.com/QNSC-VN/opshub/issues/82))
* **infra:** one stack module for both environments, and a shared cache node ([#81](https://github.com/QNSC-VN/opshub/issues/81))
* **authz:** `RoleGuard`, `RequireRoles` and `ROLES_KEY` are removed, and `Auth()` no longer accepts role arguments. `PERMISSION`/`PermissionKey` are no longer exported from `constants.ts` — import them from `@shared-kernel`, which now re-exports the catalogue. No route changes behaviour: every enforced code was already from the seeded vocabulary.

### ✨ Features

* adopt [@qnsc-vn](https://github.com/qnsc-vn) shared cache and identity primitives (rebased [#37](https://github.com/QNSC-VN/opshub/issues/37)) ([#62](https://github.com/QNSC-VN/opshub/issues/62)) ([a3846e8](https://github.com/QNSC-VN/opshub/commit/a3846e83c1012b08e0cc6cf94a98615aa3bd3757))
* **auth:** put browser sessions behind an opaque BFF cookie ([#85](https://github.com/QNSC-VN/opshub/issues/85)) ([aa09d4f](https://github.com/QNSC-VN/opshub/commit/aa09d4f890a2bb220e9a8fce51cd1bcf6de439cb))
* **authz:** one typed permission catalogue, and retire the RoleGuard ([#76](https://github.com/QNSC-VN/opshub/issues/76)) ([a6dd65a](https://github.com/QNSC-VN/opshub/commit/a6dd65a3fced9662eb2e71004db090b5b2e9ff2c))
* **db,infra:** compose the DB URL from parts, derive the JWT public key ([#82](https://github.com/QNSC-VN/opshub/issues/82)) ([a7c55b5](https://github.com/QNSC-VN/opshub/commit/a7c55b574fa2306c999ec7f98539320dee71f6b1))
* **infra:** bootstrap opshub's AWS foundations and align the shared module pins ([#79](https://github.com/QNSC-VN/opshub/issues/79)) ([72ae822](https://github.com/QNSC-VN/opshub/commit/72ae8222b1f5241804ac9f5334f5f073043e92c2))
* **infra:** give opshub prod its own dedicated cache node ([#66](https://github.com/QNSC-VN/opshub/issues/66)) ([86fb985](https://github.com/QNSC-VN/opshub/commit/86fb985f57afeb45c8933bb116b87cfbec0e7e28))
* **infra:** tunnel ingress, idling, and floors that let an environment park ([#97](https://github.com/QNSC-VN/opshub/issues/97)) ([1995ccb](https://github.com/QNSC-VN/opshub/commit/1995ccbda670e7443110308dfc74550188f193c6))
* **platform:** make StorageService endpoint-aware for R2 (config-driven) ([#52](https://github.com/QNSC-VN/opshub/issues/52)) ([fa7f687](https://github.com/QNSC-VN/opshub/commit/fa7f687f67ac254052ce6aa3d7c47130801e34ab))
* **web,infra:** adopt the Pages project and proxy /v1 same-origin ([#84](https://github.com/QNSC-VN/opshub/issues/84)) ([d2efb94](https://github.com/QNSC-VN/opshub/commit/d2efb94f5773537575cdf65e7a72b0b1b92cc2be))
* **web:** sign in through the BFF, and hold no token in the browser ([#88](https://github.com/QNSC-VN/opshub/issues/88)) ([2c5f1f8](https://github.com/QNSC-VN/opshub/commit/2c5f1f8747c19dfa48f3471866ba7140fcd5717f))


### 🐛 Bug Fixes

* **docker:** drop the base image's global npm from the runtime stages ([#83](https://github.com/QNSC-VN/opshub/issues/83)) ([84189f2](https://github.com/QNSC-VN/opshub/commit/84189f2e63886561f0957bcdee736c2780b5ade6))
* **platform:** bound the DB pool to the instance, and attribute request latency ([#86](https://github.com/QNSC-VN/opshub/issues/86)) ([20e7342](https://github.com/QNSC-VN/opshub/commit/20e73429ef92cd87b34dc56d61105424f22279b2))
* **web:** stop dropping Set-Cookie, and make the defence testable ([#87](https://github.com/QNSC-VN/opshub/issues/87)) ([86a5c67](https://github.com/QNSC-VN/opshub/commit/86a5c6762bf2db146d258909a44fc457b9ad963b))


### ♻️ Refactors

* **infra:** one stack module for both environments, and a shared cache node ([#81](https://github.com/QNSC-VN/opshub/issues/81)) ([a9361f6](https://github.com/QNSC-VN/opshub/commit/a9361f61e8c081c2930323e628fabd85fc05907d))


### 🔒 Security

* **authz:** enforce scoped grants instead of silently widening them ([#77](https://github.com/QNSC-VN/opshub/issues/77)) ([1dfac1e](https://github.com/QNSC-VN/opshub/commit/1dfac1e76e9a594789b211a43ebd93105661c6c3))
* **authz:** invalidate holders when a role's definition changes ([#78](https://github.com/QNSC-VN/opshub/issues/78)) ([a1e3b4b](https://github.com/QNSC-VN/opshub/commit/a1e3b4b91c1db559dad283b3e7f8fb7903537db6))
* **deps:** clear the CVEs blocking Security · Scan, and match rally's base image ([0de1cee](https://github.com/QNSC-VN/opshub/commit/0de1ceeba73d6c8727d85addc086cca2baebd9df))


### 📦 Dependencies

* bump the production-dependencies group with 16 updates ([#47](https://github.com/QNSC-VN/opshub/issues/47)) ([acffb9b](https://github.com/QNSC-VN/opshub/commit/acffb9b7d4a8504969f4addf932afde400a5d3fa))

## [0.1.1](https://github.com/QNSC-VN/opshub/compare/v0.1.0...v0.1.1) (2026-07-18)


### ✨ Features

* **infra:** lock develop ALB ingress to Cloudflare IPs (dev/prod parity) ([59556af](https://github.com/QNSC-VN/opshub/commit/59556af8aab6ccbccebe7fdc997138e7978d9df8))
* **infra:** migrate develop to shared runtime (Option A) ([#23](https://github.com/QNSC-VN/opshub/issues/23)) ([cdcaf8f](https://github.com/QNSC-VN/opshub/commit/cdcaf8f7163e276011ee997390580eb5be1fe106))
* migrate opshub to Cloudflare Pages + converge with rally (dev bring-up) ([#16](https://github.com/QNSC-VN/opshub/issues/16)) ([c5a83bf](https://github.com/QNSC-VN/opshub/commit/c5a83bfa6e189cb0731acce89f48bfef14d36811))
* opshub monorepo — consolidate opshub-api + opshub-web + opshub-infra ([d2d286f](https://github.com/QNSC-VN/opshub/commit/d2d286fa30b5284fb8c05f12b97adc4f316b2ae8))


### 🐛 Bug Fixes

* **auth:** add authMethod to JWT and fix sign-out redirect routing ([c5ee352](https://github.com/QNSC-VN/opshub/commit/c5ee3524bf852ea41404d8604a62044dbca7b2dd))
* **auth:** make refresh-token rotation idempotent under concurrent reuse ([#36](https://github.com/QNSC-VN/opshub/issues/36)) ([a6e5693](https://github.com/QNSC-VN/opshub/commit/a6e5693cce51dd79ea91c4a2f4ba81080cbd5b99))
* **auth:** wire GRAPH_CLIENT_SECRET; drop unused ENTRA_CLIENT_SECRET ([#28](https://github.com/QNSC-VN/opshub/issues/28)) ([505523c](https://github.com/QNSC-VN/opshub/commit/505523c968780c2703f7dfacfe29e5f2f48df5f8))
* **cache:** connect Valkey eagerly so rate limiting works ([#34](https://github.com/QNSC-VN/opshub/issues/34)) ([8fd0d44](https://github.com/QNSC-VN/opshub/commit/8fd0d4470863b3588aa048503f441d508beb0797))
* **ci:** 3 critical workflow bugs ([8ae6f91](https://github.com/QNSC-VN/opshub/commit/8ae6f9136620323f5dbec142f1ecc96635e29800))
* **ci:** resolve migration --env-file failure and typecheck errors ([38b51ca](https://github.com/QNSC-VN/opshub/commit/38b51cad61b2cf03856e5c000892ba097685d35d))
* **ci:** Trivy scans, infra-plan exit-code logic ([bee1fc7](https://github.com/QNSC-VN/opshub/commit/bee1fc7217fe955b7fe6f9353a259ed0e4c38d6e))
* **ci:** trivy-action 0.37.0 → 0.36.0 (latest) ([1a9739b](https://github.com/QNSC-VN/opshub/commit/1a9739b317ed85cfbdfed58d9714992dc8d3f8be))
* **ci:** trivy-action tag needs v prefix (v0.36.0) ([d1b0205](https://github.com/QNSC-VN/opshub/commit/d1b02058bcfb3a55ddd9a6b0ef76d44ddecf4a1d))
* **config:** treat empty Entra SSO env vars as unset ([2a78aa0](https://github.com/QNSC-VN/opshub/commit/2a78aa04ecc7877b91431e880b197afe781c2017))
* correct stale infra/ path prefix and module version drift in CI ([d33607f](https://github.com/QNSC-VN/opshub/commit/d33607f7d8904f1a91621e3ca4ac128544a26a9e))
* **db:** add SSL handling for RDS + pre-compile migrator to eliminate CVEs ([6518914](https://github.com/QNSC-VN/opshub/commit/65189149c43fea20fa1c8a7ed9af7e658d13fd34))
* **db:** drop varchar default before enum type change in migrations 0006/0008 ([56a427c](https://github.com/QNSC-VN/opshub/commit/56a427c41d3789ab3ab8924db9dce54c06761134))
* **deploy:** grant ecs:ListTasks + wake ECS in dev deploy guard ([4d78d43](https://github.com/QNSC-VN/opshub/commit/4d78d430c12b435137d9629bcf40eb326c236f22))
* **dev:** unblock opshub dev deploy (fastify dedupe + web-deploy build) ([#19](https://github.com/QNSC-VN/opshub/issues/19)) ([d9973e1](https://github.com/QNSC-VN/opshub/commit/d9973e18edebeb03d5dc442de5a51c70db14ed5a))
* **identity:** cast RefreshToken row to domain type for authMethod narrowing ([b4d04e3](https://github.com/QNSC-VN/opshub/commit/b4d04e3096d0c412e034442739830e55c0ecaa54))
* **infra/prod:** align secrets, env vars, and CDN config with develop ([85a54e4](https://github.com/QNSC-VN/opshub/commit/85a54e4dfcbc8d573d9c96f64bc408cb581dab66))
* **infra:** bump dns-record to v1.1.0 to adopt orphan ([#25](https://github.com/QNSC-VN/opshub/issues/25)) ([33030aa](https://github.com/QNSC-VN/opshub/commit/33030aabc16daa4f1f8cdaf01e1b827cba2a7c95))
* **infra:** correct secret names, add missing env vars, wire API proxy ([8293e7f](https://github.com/QNSC-VN/opshub/commit/8293e7f64e8e147c4f4aad7bc019abcd17637dc1))
* **infra:** grant develop deploy role RDS dev-cost-saver guard ([#21](https://github.com/QNSC-VN/opshub/issues/21)) ([15fb540](https://github.com/QNSC-VN/opshub/commit/15fb5406dbdaaa5078f6d916fe4d87b5fb051959))
* **infra:** make opshub ECR repos MUTABLE ([#20](https://github.com/QNSC-VN/opshub/issues/20)) ([520b44d](https://github.com/QNSC-VN/opshub/commit/520b44d0dfaf6d35e27a44c1936a14a347cf02a5))
* **jwt:** replace symmetric JWT_SECRET with EC P-256 PEM keys in vitest ([fe859d2](https://github.com/QNSC-VN/opshub/commit/fe859d25cb6b53ccdf4eea4927dffc65c566697c))
* **license:** define licenseTypeEnum + licenseStatusEnum → clean build ([9d3a4a2](https://github.com/QNSC-VN/opshub/commit/9d3a4a2a5cd3c532c695a7f1d4a810fb17cd9b72))
* **lint:** resolve all pre-existing ESLint errors ([4b483d0](https://github.com/QNSC-VN/opshub/commit/4b483d07cb9be7173eeff879d153d28d0a8c176f))
* **opshub dev:** dedupe fastify to unblock backend build + fix web-deploy build cmd ([#17](https://github.com/QNSC-VN/opshub/issues/17)) ([81f2b5a](https://github.com/QNSC-VN/opshub/commit/81f2b5a133f49852c7017afc9f33d2409c66b6ed))
* **release:** emit vX.Y.Z tags so Release PR triggers deploy ([#49](https://github.com/QNSC-VN/opshub/issues/49)) ([335e28c](https://github.com/QNSC-VN/opshub/commit/335e28c2c4ae3b59c9494d5222e11b39c1c91b07))
* remove ScheduleModule from API, wire relay services to worker only ([afc105d](https://github.com/QNSC-VN/opshub/commit/afc105d0ad29e483de5fd77f379536ded9ceea8a))
* **security-posture:** register SecurityPostureSyncCron as a provider ([b61fd6b](https://github.com/QNSC-VN/opshub/commit/b61fd6bc7b18039ded4c4a9ea73abdafc30f6c27))
* **storage:** wire S3_FILES_BUCKET; drop unused S3_UPLOAD_BUCKET ([#29](https://github.com/QNSC-VN/opshub/issues/29)) ([52438a9](https://github.com/QNSC-VN/opshub/commit/52438a9539e403f2b68cf7b6e0f942b22a6ac502))
* **test:** add missing test scaffold and COOKIE_SECRET to vitest env ([b24983d](https://github.com/QNSC-VN/opshub/commit/b24983d37a38b2031826f9adbbfe91aadab85482))
* **test:** use explicit vi import, set coverage thresholds to current baseline ([5f8a120](https://github.com/QNSC-VN/opshub/commit/5f8a1204df52ec5b1b60c5fbcc39ca61411204eb))
* web-deploy IAM trust policy referenced archived opshub-web repo ([d0e6591](https://github.com/QNSC-VN/opshub/commit/d0e65914220ebe50ba60ff7b057e1990b5cad21e))
* **worker:** consolidate scheduled crons to worker process only ([8293e7f](https://github.com/QNSC-VN/opshub/commit/8293e7f64e8e147c4f4aad7bc019abcd17637dc1))


### ⚡ Performance

* cache JWKS instance in AuthService to avoid per-login key fetch ([1b9e9ec](https://github.com/QNSC-VN/opshub/commit/1b9e9ec977440ce41dceab34000e4f7b9dbba540))


### ♻️ Refactors

* adopt shared alb, dns-record, oneshot-task modules; export cloudflare facts from bootstrap ([6edad28](https://github.com/QNSC-VN/opshub/commit/6edad28224cbc2a7cba8940893db2cb717da460c))
* eliminate DRY violations — shared-kernel primitives, DTO pagination, pgEnums ([050a209](https://github.com/QNSC-VN/opshub/commit/050a209421fc022140515267272570f0edd1bd71))
* **platform:** move denylist check from JwtStrategy to JwtAuthGuard ([1a3f33c](https://github.com/QNSC-VN/opshub/commit/1a3f33cddde2305eb2732f177a76251bb04b2621))
* remove devLogin and narrow AuthMethod to sso-only ([c62da18](https://github.com/QNSC-VN/opshub/commit/c62da1840c5bb6f1f07acbd801d8160f48e324c6))
* use shared qnsc-ci release-commenter reusable ([#54](https://github.com/QNSC-VN/opshub/issues/54)) ([204e1d3](https://github.com/QNSC-VN/opshub/commit/204e1d3a065434a5f189458ed868822c683fbf9f))


### 🔒 Security

* enterprise audit — RBAC guards, CSRF, FK constraints, type fixes ([5f796a6](https://github.com/QNSC-VN/opshub/commit/5f796a6e63fd8f0675e83e862e9717906280dbfe))


### 📦 Dependencies

* bump the development-dependencies group across 1 directory with 17 updates ([#18](https://github.com/QNSC-VN/opshub/issues/18)) ([146263a](https://github.com/QNSC-VN/opshub/commit/146263a40f68e2376d768068ce4624ff7c519693))
* bump the production-dependencies group across 1 directory with 20 updates ([#9](https://github.com/QNSC-VN/opshub/issues/9)) ([400b474](https://github.com/QNSC-VN/opshub/commit/400b474ec5613d993826ff6b166fc1d12d836987))
