import { useEffect, useState } from "react"
import socket from "../socket";

type ChatMessage = {
    senderId: string
    text: string
    timestamp: number,
    socketId: string,
}

export default function Chat({players}) {
    const [messages, setMessages] = useState<ChatMessage[]>([])
    const [input, setInput] = useState("")

    useEffect(() => {
        socket.on("chat:message", message => {
            setMessages(prev => [...prev, message])
        })

        return () => {
            socket.off("chat:message")
        }
    }, [])

    const sendMessage = () => {
        if (!input.trim()) return

        socket.emit("chat:message", input)
        setInput("")
    }

    return (
        <div className="chat">
            <div className="chat__log">
                {messages.map((msg, i) => (
                    <div key={i} className="chat__msg">
                        <strong className="chat__id">{players.find(p => p.socketId === msg.senderId).name}:</strong>{" "}
                        <span className="chat__text">{msg.text}</span>
                    </div>
                ))}
            </div>

            <div className="chat__composer">
                <input
                    className="chat__input"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                    placeholder="Type message…"
                />
                <button className="btn btn--ghost chat__send" onClick={sendMessage}>
                    Send
                </button>
            </div>
        </div>

    )
}
