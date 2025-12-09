"use client"

import { Button } from "@/components/ui/button"
import type { Book } from "@/lib/types"

interface BookStatusFormProps {
  currentStatus: Book["status"]
  onStatusChange: (status: Book["status"]) => void
}

export function BookStatusForm({ currentStatus, onStatusChange }: BookStatusFormProps) {
  const statuses: Array<{ value: Book["status"]; label: string; color: string }> = [
    { value: "to-read", label: "Want to Read", color: "bg-purple-100 text-purple-800" },
    { value: "reading", label: "Currently Reading", color: "bg-blue-100 text-blue-800" },
    { value: "read", label: "Read", color: "bg-green-100 text-green-800" },
    { value: "unread", label: "Unread", color: "bg-gray-100 text-gray-800" },
  ]

  return (
    <div className="space-y-2">
      <p className="text-sm text-foreground-light mb-3">Select new status:</p>
      <div className="grid grid-cols-2 gap-2">
        {statuses.map((status) => (
          <Button
            key={status.value}
            onClick={() => onStatusChange(status.value)}
            variant={currentStatus === status.value ? "default" : "outline"}
            className={currentStatus === status.value ? "bg-primary text-white" : "border-border"}
          >
            {status.label}
          </Button>
        ))}
      </div>
    </div>
  )
}
