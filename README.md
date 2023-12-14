<img src='https://raw.githubusercontent.com/local-first-web/branding/main/svg/relay-h.svg'
width='600' alt="@localfirst/relay logo"/>

`@localfirst/relay` is a tiny service that helps local-first applications connect with peers on
other devices. It can run in the cloud or on any device with a known address.

Deploy to:
[Glitch](#deploying-to-glitch) |
[Heroku](#deploying-to-heroku) |
[AWS](#deploying-to-aws-elastic-beanstalk) |
[Google](#deploying-to-google-cloud) |
[Azure](#deploying-to-azure) |
[local server](#server)

## Why

<img src='./images/relay-1.png' width='500' align='center' ></img>

Getting two end-user devices to communicate with each other over the internet is
[hard](https://tailscale.com/blog/how-nat-traversal-works/). Most devices don't have stable public
IP addresses, and they're often behind firewalls that turn away attempts to connect from the
outside. This is a **connection** problem.

Even within a local network, or in other situations where devices can be reached directly, devices
that want to communicate need a way to find each other. This is a problem of **discovery**.

## What

This little server offers a solution to each of these two problems.

### 1. Discovery

Alice can provide a `documentId` (or several) that she's interested in. (A `documentId`
is a unique ID for a topic or channel — it could be a GUID, or just a unique string like
`ambitious-mongoose`.)

[![diagram](./images/relay-introduction.png)](https://raw.githubusercontent.com/local-first-web/relay/master/images/relay-introduction.png)

If Bob is interested in the same `documentId`, each will receive an `Introduction`
message with the other's peerId. They can then use that information to connect.

### 2. Connection

Alice can request to connect with Bob on a given documentId. If we get matching connection
requests from Alice and Bob, we pipe their sockets together.

[![diagram](./images/relay-connection.png)](https://raw.githubusercontent.com/local-first-web/relay/master/images/relay-connection.png)

## How

### Server

From this repo, you can run this server as follows:

```bash
pnpm
pnpm start
```

You should see something like thsi:

```bash
> @localfirst/relay@4.0.0 start local-first-web/relay
> node dist/start.js

🐟 Listening at http://localhost:8080
```

You can visit that URL with a web browser to confirm that it's working; you should see something like this:

<img src='./images/screenshot.png' width='300' align='center' />

#### Running server from another package

From another codebase, you can import the server and run it as follows:

```ts
import { Server } from "@localfirst/relay/Server.js"

const DEFAULT_PORT = 8080
const port = Number(process.env.PORT) || DEFAULT_PORT

const server = new Server({ port })

server.listen()
```

### Client

This library includes a lightweight client designed to be used with this server.

The client keeps track of all peers that the server connects you to, and for each peer it keeps
track of each documentId (aka discoveryKey, aka channel) that you're working with that peer on.

```ts
import { Client } from "@localfirst/relay/Client.js"

client = new Client({ peerId: "alice", url: "myrelay.somedomain.com" })
  .join("ambitious-mongoose")
  .on("peer-connect", ({ documentId, peerId, socket }) => {
    // `socket` is a WebSocket

    // send a message
    socket.write("Hello! 🎉")

    // listen for messages
    socket.addEventListener("data", event => {
      const message = event.data
      console.log(`message from ${peerId} about ${documentId}`, message)
    })
  })
```

## ⚠ Security

This server makes no security guarantees. Alice and Bob should probably:

1.  **Authenticate** each other, to ensure that "Alice" is actually Alice and "Bob" is actually Bob.
2.  **Encrypt** all communications with each other.

The [@localfirst/auth] library can be used with this relay service. It provides peer-to-peer
authentication and end-to-end encryption, and allows you to treat this relay (and the rest of the
network) as untrusted.

## Server API

> The following documentation might be of interest to anyone working on the @localfirst/relay
> `Client`, or replacing it with a new client. You don't need to know any of this to interact with
> this server if you're using the included client.

This server has two WebSocket endpoints: `/introduction` and `/connection`.

In the following examples, Alice is the local peer and Bob is a remote peer. We're using `alice` and `bob` as their `peerId`s; in practice, typically these would be GUIDs that uniquely identify their devices.

#### `/introduction/:localPeerId`

- `:localPeerId` is the local peer's unique `peerId`.

Alice connects to this endpoint, e.g. `wss://myrelay.somedomain.com/introduction/alice`.

Once a WebSocket connection has been made, Alice sends an introduction request containing one or more `documentId`s that she has or is interested in:

```ts
{
  type: 'Join',
  documentIds: ['ambitious-mongoose', 'frivolous-platypus'], // documents Alice has or is interested in
}
```

If Bob is connected to the same server and interested in one or more of the same documents IDs, the
server sends Alice an introduction message:

```ts
{
  type: 'Introduction',
  peerId: 'bob', // Bob's peerId
  documentIds: ['ambitious-mongoose'] // documents we're both interested in
}
```

Alice can now use this information to request a connection to this peer via the `connection` endpoint:

#### `/connection/:localPeerId/:remotePeerId/:documentId`

Once Alice has Bob's `peerId`, she makes a new connection to this endpoint, e.g.
`wss://myrelay.somedomain.com/connection/alice/bob/ambitious-mongoose`.

- `:localPeerId` is the local peer's unique `peerId`.
- `:remotePeerId` is the remote peer's unique `peerId`.
- `:documentId` is the document ID.

If and when Bob makes a reciprocal connection by connecting to
`wss://myrelay.somedomain.com/connection/bob/alice/ambitious-mongoose`, the server pipes their
sockets together and leaves them to talk.

The client and server don't communicate with each other via the `connection` endpoint; it's purely a
relay between two peers.

## Deployment

### Deploying to Glitch

You can deploy this relay to [Glitch](https://glitch.com) by clicking this button:

[![Remix on Glitch](https://cdn.glitch.com/2703baf2-b643-4da7-ab91-7ee2a2d00b5b%2Fremix-button.svg)](https://glitch.com/edit/#!/import/github/local-first-web/relay)

Alternatively, you can remix the [**local-first-relay**](https://glitch.com/edit/#!/local-first-relay) project.

### Deploying to Heroku

This server can be deployed to [Heroku](https://heroku.com). By design, it should only ever run with a single dyno. You can deploy it by clicking on this button:

[![Deploy](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy)

Or, you can install using the [Heroku CLI](https://devcenter.heroku.com/articles/heroku-cli) as follows:

```bash
heroku create
git push heroku main
heroku open
```

### Deploying to AWS Elastic Beanstalk

Install using the [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv1.html):

```bash
eb init
eb create
eb open
```

### Deploying to Google Cloud

Install using the [Google Cloud SDK](https://cloud.google.com/sdk/docs/):

```bash
gcloud projects create my-local-first-relay --set-as-default
gcloud app create
gcloud app deploy
gcloud app browse
```

### Deploying to Azure

Install using the [Azure CLI](https://docs.microsoft.com/en-us/cli/azure/install-azure-cli?view=azure-cli-latest):

```bash
az group create --name my-local-first-relay --location eastus
az configure --defaults group=my-local-first-relay location=eastus
az appservice plan create --name my-local-first-relay --sku F1
az webapp create --name my-local-first-relay --plan my-local-first-relay
az webapp deployment user set --user-name PEERID --password PASSWORD
az webapp deployment source config-local-git --name my-local-first-relay
git remote add azure https://PEERID@my-local-first-relay.scm.azurewebsites.net/my-local-first-relay.git
git push azure main
az webapp browse --name my-local-first-relay
```

### AWS Lambda, Azure Functions, Vercel, Serverless, Cloudwatch Workers, etc.

Since true serverless functions are stateless and only spun up on demand, they're not a good fit for
this server, which needs to remember information about connected peers and maintain a stable
websocket connection with each one.

## License

MIT

## Prior art

Inspired by https://github.com/orionz/discovery-cloud-server

Formerly known as 🐟 Cevitxe Signal Server. (Cevitxe is now [@localfirst/state])

[@localfirst/state]: https://github.com/local-first-web/state
[@localfirst/auth]: https://github.com/local-first-web/auth
[@localfirst/relay-client]: ./packages/client/
[server tests]: ./packages/relay/src/Server.test.ts
