# TwitterDB

X（Twitter）アーカイブの `tweets.js` を読み込み、過去投稿を検索・絞り込みできる個人用データベースです。

## データの置き方

Xアーカイブ内の `data/tweets.js` を、このリポジトリのルートへ `tweets.js` という名前で配置してください。

## 主な機能

- 本文検索
- 開始日・終了日による絞り込み
- 通常投稿・返信・引用・リポストの絞り込み
- 返信先アカウントによる絞り込み
- 元投稿をXで開く
- 手動で一覧から削除
- 削除済み一覧から復元
- GitHub経由で削除状態を端末間同期

X側の削除状態は自動検知しません。Xで削除した投稿を、TwitterDB側でも手動で削除してください。

## 削除状態の同期

削除した投稿IDは、リポジトリ内の `deleted.json` に保存されます。iPhone・iPad・Macなど、どの端末から開いても同じ削除状態が読み込まれます。

削除・復元を行う端末では、サイト右上の「同期設定」からFine-grained personal access tokenを登録してください。トークンはその端末のブラウザ内だけに保存され、リポジトリや `tweets.js` には書き込まれません。

### トークンの設定

1. GitHubの Settings → Developer settings → Personal access tokens → Fine-grained tokens を開く
2. Resource ownerを `4k29` にする
3. Repository accessを `Only select repositories` にして `TwitterDB` だけを選ぶ
4. Repository permissionsの `Contents` を `Read and write` にする
5. 作成したトークンをTwitterDBの「同期設定」に入力する

トークンはパスワードと同じ扱いです。チャット、リポジトリ、スクリーンショットなどへ貼らないでください。
