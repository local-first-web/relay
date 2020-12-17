<img src='https://raw.githubusercontent.com/local-first-web/branding/main/svg/relay-v.svg' width='250' alt="@localfirst/relay logo"/>

This server provides two services:

- **Introduction** (aka discovery): A client can provide one or more document keys that they're
  interested in. If any other client is interested in the same key or keys, each will receive an
  `Introduction` message with the other's id. They can then use that information to connect.

- **Connection**: Client A can request to connect with Client B on a given document ID. If we get
  matching connection requests from A and B, we just pipe their sockets together.

![diagram](./images/local-first-relay.png)

## Running locally

From this monorepo, you can run this server as follows:

```bash
$ yarn start
```

You should see something like thsi:

```bash
yarn run v1.22.4
$ yarn workspace @localfirst/relay start
$ node dist/start.js
🐟 Listening at http://localhost:8080
```

You can visit that URL with a web browser to confirm that it's working; you should see a big ol' fish emoji:

<img src='./images/screenshot.png' width='300' />

## Deployment

The easiest way to stand one of these up is to use the [@localfirst/relay-standalone] repo, which is
optimized for deployment. In that repo you'll find instructions for deploying to Heroku, AWS Elastic
Beanstalk, Google Cloud Platform, and Glitch.

## Usage

[@localfirst/relay-client], included in this repo, is a simple discovery cloud client library
designed to be used with this server.

You don't strictly need to use this client - you could interact directly with the server the way we
do in the [server tests] - but it automates the business of accepting invitations when they're
received.

The client keeps track of all peers that the server connects you to, and for each peer it keeps
track of each key (aka discoveryKey, aka channel) that you're working with that peer on.

The simplest workflow is something like this:

```ts
client = new Client({ id: 'my-peer-id', url })
client.join('my-document-id')
client.on('peer', (peer, key) => {
  const socket = peer.get(key) // `socket` is a WebSocket instance

  // send a message
  socket.send('Hello!')

  // listen for messages
  socket.onmessage = () => {
    console.log(messsage)
  }
})
```

## API

> The following documentation might be of interest to anyone working on the client, or replacing it
> with a new client. You don't need to know any of this to interact with this server if you're using
> the client.

This server has two WebSocket endpoints: `introduction` and `connection`.

### Introduction endpoint: `/introduction/:localId`

- I connect to this endpoint, e.g. `wss://your.domain.com/introduction/aaaa4242`.

  - `:localId` is my unique client identifier.

- Once a WebSocket connection has been made, I send an introduction request containing one or more
  document IDs I'm interested in joining:

  ```ts
  {
    type: 'Join',
    join: ['happy-raccoon', 'hairy-thumb'], // documents I have or am interested in
  }
  ```

- If another peer is connected to the same server and interested in one or more of the same
  documents IDs, the server sends me an introduction message:

  ```ts
  {
    type: 'Introduction',
    id: 'qrst7890', // the peer's id
    keys: ['happy-raccoon'] // documents we're both interested in
  }
  ```

- I can now use this information to request a connection to this peer via the `connection` endpoint:

### Connection endpoint: `/connection/:localId/:remoteId/:key`

Once I've been given a peer's ID, I make a new connection to this endpoint, e.g.
`wss://your.domain.com/connection/aaaa4242/qrst7890/happy-raccoon`.

- `:localId` is my unique client identifier.
- `:remoteId` is the peer's unique client identifier.
- `:key` is the document ID.

If and when the peer makes a reciprocal connection, e.g.
`wss://your.domain.com/connection/qrst7890/aaaa4242/happy-raccoon`, the server pipes their sockets
together and leaves them to talk.

The client and server don't communicate with each other via the `connection` endpoint; it's purely a
relay between two peers.

## License

MIT

## Prior art

Inspired by https://github.com/orionz/discovery-cloud-server

[client]: ./packages/relay-client/README.md
[@localfirst/relay-standalone]: https://github.com/local-first-web/relay-deployable
[server tests]: ./packages/relay/src/Server.test.ts
