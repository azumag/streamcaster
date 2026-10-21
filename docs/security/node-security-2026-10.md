# Node.js / npm セキュリティ更新（2026-10-21）

## 対象と変更

確認元: `5bd511ed3d74c339e4c81379a91a9b037517dc14`。

- 開発環境とcontrollerコンテナをNode.js 22.23.4へ固定。CIは22.23.4と24.22.1を使用する。
- `engines`は修正版の22/24/26系列だけを許可する。単純な`>=22.23.4`では古い24/26も許可されるため使用しない。
- controllerコンテナは公式Nodeイメージと独立lockfileの`npm ci --omit=dev --ignore-scripts`を使用する。ホストの`node_modules`をコンテナへ上書きコピーしない。
- 新規ホストのbootstrapは`.node-version`に指定した公式配布物をSHA-256照合して導入する。既存ホストを変更する処理ではない。
- workspaceとcontroller単独の両lockfileを更新。Express 4.22.3、proxy-addr 2.0.8、form-data 4.0.6、protobufjs 7.6.6等の修正版を採用した。
- Jestを30.5.2へ明示更新して、修正版のないbraces経路を除去。直接利用のUUIDはCommonJS対応の11.1.1へ更新した。`npm audit fix --force`と依存の強制overrideは使用していない。
- CIにhigh以上の監査ゲートとcontrollerイメージのbuildのみを追加した。

Node.js 22.23.4にはeMudhraの不正中間CAのSPKI拒否と証明書ストア更新が含まれる。
TLS検証を無効化する設定は追加していない。

## 監査結果

`npm audit`の2026-10-21時点の結果。数は脆弱な依存ノード数であり、独立した脆弱性の数ではない。

| 対象 | 変更前 | 変更後 |
| --- | --- | --- |
| workspace lock | critical 3 / high 39 / moderate 11 / low 1 | moderate 24、critical/high/low 0 |
| controller単独lock | 更新前全件の別集計は未採取 | moderate 24、critical/high/low 0 |
| workspace本番依存のみ | 未採取 | moderate 5、critical/high 0 |

残件は次の2件のadvisoryに由来する。

1. **sprintf-js: GHSA-hp3w-g68c-fv3c（moderate、修正版なし）**
   - 開発依存の`jest → @jest/transform → babel-plugin-istanbul → @istanbuljs/load-nyc-config → js-yaml@3 → argparse → sprintf-js@1.0.3`。
   - 巨大なprecisionを含む書式文字列でDoSとなる。ここではテスト・coverage設定を処理する経路で、本番の`npm ci --omit=dev`には含まれない。
   - Jest 30.5.2でも残る。監査が提案する旧Jestへのダウングレードは採用しない。上流の依存更新が出た時点で両lockを更新し、既存テストを再実行する。
2. **uuid: GHSA-w5hq-g745-h8pq（moderate）**
   - 本番依存の`dockerode@4.0.6 → uuid@10.0.0`、`googleapis@128 → googleapis-common@7 → uuid@9.0.1`、`gaxios@6.7.1 → uuid@9.0.1`。
   - advisoryの条件はv3/v5/v6へ出力bufferを渡す場合。確認した利用元は`v4()`を引数なしで呼ぶ。直接依存は修正版に更新済み。
   - Google SDKのmajor更新や推移依存へのmajor overrideは、このPRで互換性を保証できないため行わない。上流の修正、またはDrive認証・一覧取得・ダウンロードを検証するSDK移行が必要。

WizのKeyv関連IoC（`wiz-sec-public/wiz-research-iocs/reports/keyv-packages.csv`、blob SHA
`9f165191323ff74a6d06ed6115363f0cdc912d2e`）と両lockの変更前後をpackage名とversionの組で照合し、一致は0件。
実際の過去インストール、グローバルCLI、キャッシュ、既存イメージの侵害有無を証明する検査ではない。

## 検証

Node.js 22.23.4 / npm 10.9.9で実施。

- workspaceとcontroller単独の`npm ci --ignore-scripts`が成功。
- controller / operator-bridgeのlintが成功。
- controller: 15 suites / 111 tests成功、既存coverage閾値を達成。
- operator-bridge: 5 suites / 19 tests成功。
- `npm run blmf:windows:test`: 30 tests成功（Linux上のfixtureテスト）。
- `.github/workflows`のYAML解析、bootstrapの`bash -n`、`git diff --check`が成功。
- `engines`が22.23.4/24.22.1/26.12.1を許可し、直前の未修正patchを拒否することを確認。

最初のsandbox実行ではlocalhost listenがEPERMとなったため、fixture専用の許可済みローカル実行で再検証した。
Docker実行環境がないためローカルimage buildは未実施。追加したPR CIで確認する。
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
