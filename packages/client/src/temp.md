This is a client for `relay` that keeps track of all peers that the server connects you to, and
for each peer it keeps track of each documentId (aka discoveryKey, aka channel) that you're
working with that peer on.

The peers are WebSocket instances

The simplest workflow is something like this:

```ts
client = new Client({ userName: 'my-peer-userName', url })
  .join('my-document-userName')
  .on('peer.connect', ({ documentId, userName, socket }) => {
    // send a message
    socket.send('Hello!')

    // listen for messages
    socket.onmessage = e => {
      const { data } = e
      console.log(data)
    }
  })
```
