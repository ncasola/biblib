import { Badge } from "@/components/ui/badge"
import type { Book } from "@/lib/types"

interface BookStatusBadgeProps {
  status: Book["status"]
}

export function BookStatusBadge({ status }: BookStatusBadgeProps) {
  const statusConfig = {
    read: { label: "Leído", className: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" },
    reading: {
      label: "Leyendo",
      className: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
    },
    "to-read": {
      label: "Por leer",
      className: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
    },
    unread: { label: "Sin empezar", className: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200" },
  }

  const config = statusConfig[status] || statusConfig.unread

  return <Badge className={config.className}>{config.label}</Badge>
}
