# Node.js / npm セキュリティ更新（2026-10-21）

## 対象と変更

確認元: `5bd511ed3d74c339e4c81379a91a9b037517dc14`。

- 開発環境とcontrollerコンテナをNode.js 22.23.4へ固定。CIは22.23.4と24.22.1を使用する。
- `engines`は修正版の22/24/26系列だけを許可する。単純な`>=22.23.4`では古い24/26も許可されるため使用しない。
- controllerコンテナは公式Nodeイメージと独立lockfileの`npm ci --omit=dev --ignore-scripts`を使用する。ホストの`node_modules`をコンテナへ上書きコピーしない。
- 新規ホストのbootstrapは`.node-version`に指定した公式配布物をSHA-256照合して導入する。既存ホストを変更する処理ではない。
- workspaceとcontroller単独の両lockfileを更新。Express 4.22.3、proxy-addr 2.0.8、form-data 4.0.6、protobufjs 7.6.6等の修正版を採用した。
- Jestを30.5.2へ明示更新して、修正版のないbraces経路を除去。直接利用のUUIDはCommonJS対応の11.1.1へ更新した。
- CIで検出したUUIDと開発依存のsprintf-js経路は、親パッケージを限定した4件のoverrideで除去。両manifestに同じ指定を置き、workspaceとcontroller単独の両方に反映した。`npm audit fix --force`は使用していない。
- CIにhigh以上の監査ゲートとcontrollerイメージのbuildのみを追加した。

Node.js 22.23.4にはeMudhraの不正中間CAのSPKI拒否と証明書ストア更新が含まれる。
TLS検証を無効化する設定は追加していない。

## 監査結果

`npm audit`の2026-10-21時点の結果。数は脆弱な依存ノード数であり、独立した脆弱性の数ではない。

| 対象 | 変更前 | 変更後 |
| --- | --- | --- |
| workspace lock | critical 3 / high 39 / moderate 11 / low 1 | 全severity 0 |
| controller単独lock | 更新前全件の別集計は未採取 | 全severity 0 |
| workspace本番依存のみ | 未採取 | 全severity 0 |
| controller単独の本番依存のみ | 未採取 | 全severity 0 |

初回の更新で残った次の2件のadvisoryも解消した。advisoryの無視設定は追加していない。

1. **uuid: CVE-2026-41907 / GHSA-w5hq-g745-h8pq（npm moderate）**
   - 本番依存の`dockerode@4.0.6 → uuid@10.0.0`、`googleapis@128 → googleapis-common@7 → uuid@9.0.1`、`gaxios@6.7.1 → uuid@9.0.1`が対象。初回TrivyもUUID 9/10を検出した。
   - 公式修正版は11.1.1 / 12.0.1 / 13.0.1。Dockerode 4.0.12もUUID 10を指定しており、利用親の同major更新だけでは解消しない。
   - `dockerode@^4.0.2`、`googleapis-common@7`、`gaxios@6`の直下だけUUIDを11.1.1へ固定。両lockからUUID 9/10を除去した。
   - advisoryの条件はv3/v5/v6へ出力bufferを渡す場合。利用元の実コードはいずれもCommonJSから引数なしの`v4()`を呼ぶ。修正版でもこのAPIが維持されることを、実際のDockerode session生成、Google Drive SDKとGaxiosのmultipart生成を通じて確認した。通信部分だけをfixtureに置き換え、外部接続は行わない。
2. **sprintf-js: GHSA-hp3w-g68c-fv3c（moderate、sprintf-js自体の修正版なし）**
   - 旧経路は開発依存の`jest → @jest/transform → babel-plugin-istanbul → @istanbuljs/load-nyc-config → js-yaml@3 → argparse@1 → sprintf-js@1.0.3`。巨大なprecisionを含む書式文字列によるDoSが対象で、本番の`npm ci --omit=dev`には含まれなかった。
   - `@istanbuljs/load-nyc-config@1`の直下だけjs-yamlを4.3.2へ固定し、argparse 2を使う経路へ移した。両lockからsprintf-jsを除去した。
   - 親の実装が呼ぶAPIは`load()`のみ。実際の`loadNycConfig()`に一時YAMLを渡し、`extends`、配列、boolean、設定名のcamelCase変換を確認した。既存coverageも通過している。

このoverrideは、上流が修正版の依存を採用した時点で個別に外し、同じ契約テストと両lockの監査を再実行する。

WizのKeyv関連IoC（`wiz-sec-public/wiz-research-iocs/reports/keyv-packages.csv`、blob SHA
`9f165191323ff74a6d06ed6115363f0cdc912d2e`）と両lockの変更前後をpackage名とversionの組で照合し、一致は0件。
実際の過去インストール、グローバルCLI、キャッシュ、既存イメージの侵害有無を証明する検査ではない。

## 検証

Node.js 22.23.4 / npm 10.9.9で実施。

- workspaceとcontroller単独の`npm ci --ignore-scripts`が成功。
- controller / operator-bridgeのlintが成功。
- controller: workspace、単独lockとも16 suites / 115 tests成功、既存coverage閾値を達成。うち4件は上記の実SDK/adapter/YAML読み込み契約テスト。
- operator-bridge: 5 suites / 19 tests成功。
- `npm run blmf:windows:test`: 30 tests成功（Linux上のfixtureテスト）。
- workspaceとcontroller単独の全依存/本番依存の`npm audit`がすべて0件。UUID 9/10とsprintf-jsが両lockにないことを確認。
- `NODE_PATH`を空にして、実際の親パッケージがリポジトリ内のUUID 11.1.1 / js-yaml 4.3.2を解決することを確認。外部の共有node_modulesへのfallbackを検証結果に含めない。
- `.github/workflows`のYAML解析、bootstrapの`bash -n`、`git diff --check`が成功。
- `engines`が22.23.4/24.22.1/26.12.1を許可し、直前の未修正patchを拒否することを確認。

最初のsandbox実行ではlocalhost listenがEPERMとなったため、fixture専用の許可済みローカル実行で再検証した。
Docker実行環境がないためローカルimage buildは未実施。初回PR CIのcontroller image build、Node 22/24 matrix、integration、Windows PoCは成功した。依存override追補後のCIでも再確認する。
Windows実機、Google Drive実アカウント、OBS、配信先には接続していない。

## 適用条件

PRのmergeだけで既存コンテナ・ホスト・常駐プロセスが更新されるわけではない。
既存のmain pushには本番deploy workflowがあるため、mergeは運用手順に沿って行う。
適用時はコンテナを新しいbase/lockから再buildし、開発用containerと既存ホストのNodeも更新する。
再起動後に実際のcontrollerの`process.version`を確認し、古いプロセスとTLSセッションが残っていないことを確認する。
本変更の作業ではmerge、deploy、常駐プロセス再起動、配信操作は実施していない。

## 根拠

- [Node.js 22.23.4 release](https://nodejs.org/en/blog/release/v22.23.4)
- [eMudhra SPKI blocklist](https://github.com/nodejs/node/pull/66871)
- [NSS certificate store update](https://github.com/nodejs/node/pull/66877)
- [Jest 30 upgrade guide](https://jestjs.io/docs/upgrading-to-jest30)
- [sprintf-js advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)
- [uuid advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq)
- [Wiz IoC repository](https://github.com/wiz-sec-public/wiz-research-iocs/blob/main/reports/keyv-packages.csv)
