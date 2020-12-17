<img src='https://raw.githubusercontent.com/local-first-web/branding/main/svg/relay-localfirst-icon-name-box.svg' height='100' />

`@localfirst/relay-client` is a simple discovery cloud client library that can be paired with [@localfirst/relay].

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

[@localfirst/relay]: https://github.com/local-first-web/relay/
[server tests]: https://github.com/local-first-web/state/blob/master/packages/relay/src/Server.test.ts
