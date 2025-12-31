import { useEffect, useState } from "react"
import socket from "../socket";

type ChatMessage = {
    id: string
    text: string
    timestamp: number
}

export default function Chat() {
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
        <div style={{ width: 300 }}>
            <div style={{ height: 200, overflowY: "auto", border: "1px solid #444" }}>
                {messages.map((msg, i) => (
                    <div key={i}>
                        <strong>{msg.id.slice(0, 4)}:</strong> {msg.text}
                    </div>
                ))}
            </div>

            <input
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && sendMessage()}
            />
            <button onClick={sendMessage}>Send</button>
        </div>
    )
}
