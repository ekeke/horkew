import type { Party, Server, Connection } from "partykit/server"

export default class HorkewRelay implements Server {
  latestText: string | null = null

  constructor(readonly room: Party) {}

  onConnect(conn: Connection) {
    if (this.latestText !== null) {
      conn.send(this.latestText)
    }
  }

  onMessage(message: string, sender: Connection) {
    this.latestText = message
    for (const conn of this.room.getConnections()) {
      if (conn.id !== sender.id) {
        conn.send(message)
      }
    }
  }
}
