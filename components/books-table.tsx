"use client"

import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
  getPaginationRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  type SortingState,
  type ColumnFiltersState,
} from "@tanstack/react-table"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { Book, Shelf } from "@/lib/types"
import { useState, useMemo } from "react"
import Image from "next/image"
import { ChevronLeft, ChevronRight, Search, Filter } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { BookStatusBadge } from "@/components/book-status-badge"
import Link from "next/link"

interface BooksTableProps {
  books: Book[]
  shelves: Shelf[]
}

const columns: ColumnDef<Book>[] = [
  {
    accessorKey: "cover",
    header: "Cover",
    cell: ({ row }) => (
      <div className="relative w-10 h-16">
        <Image
          src={row.original.cover.small || "/placeholder.svg"}
          alt={row.original.title}
          fill
          sizes="40px"
          className="object-cover rounded border border-border"
          onError={(e) => {
            e.currentTarget.src = "/placeholder.svg?height=64&width=40"
          }}
        />
      </div>
    ),
    size: 60,
  },
  {
    accessorKey: "title",
    header: "Title",
    cell: ({ row }) => (
      <div>
        <p className="font-medium text-foreground">{row.original.title}</p>
        {row.original.subtitle && <p className="text-xs text-foreground-light">{row.original.subtitle}</p>}
      </div>
    ),
  },
  {
    accessorKey: "authors",
    header: "Author(s)",
    cell: ({ row }) =>
      row.original.authors && row.original.authors.length > 0
        ? row.original.authors
            .map((a) => a.name)
            .join(", ")
            .substring(0, 50) + (row.original.authors.map((a) => a.name).join(", ").length > 50 ? "..." : "")
        : "Unknown",
  },
  {
    accessorKey: "number_of_pages",
    header: "Pages",
    cell: ({ row }) => row.original.number_of_pages || "-",
  },
  {
    accessorKey: "publish_date",
    header: "Published",
    cell: ({ row }) => row.original.publish_date || "-",
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => <BookStatusBadge status={row.original.status} />,
  },
  {
    id: "actions",
    header: "Actions",
    cell: ({ row }) => (
      <Link href={`/book/${row.original.id}`}>
        <button className="text-primary hover:text-primary-dark text-sm font-medium">View</button>
      </Link>
    ),
  },
]

export function BooksTable({ books, shelves }: BooksTableProps) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState("")
  const [selectedShelf, setSelectedShelf] = useState<string>("all")

  const filteredBooks = useMemo(() => {
    console.log("[v0] Filtering books by shelf:", selectedShelf)
    return selectedShelf === "all" ? books : books.filter((book) => book.shelf_id === selectedShelf)
  }, [books, selectedShelf])

  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: filteredBooks,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    state: {
      sorting,
      columnFilters,
      globalFilter,
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: (row, columnId, filterValue) => {
      const title = row.original.title.toLowerCase()
      const authors = row.original.authors
        .map((a) => a.name)
        .join(" ")
        .toLowerCase()
      const searchTerm = filterValue.toLowerCase()
      return title.includes(searchTerm) || authors.includes(searchTerm)
    },
  })

  if (books.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-foreground-light mb-4">No books in your library yet.</p>
        <p className="text-sm text-foreground-light">Add your first book to get started!</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Search Input */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 sm:gap-4">
        <div className="flex items-center gap-2 flex-1">
          <Search className="w-4 h-4 text-foreground-light flex-shrink-0" />
          <Input
            placeholder="Search by title or author..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="bg-surface border-border"
          />
        </div>

        <div className="flex items-center gap-2 sm:min-w-[200px]">
          <Filter className="w-4 h-4 text-foreground-light flex-shrink-0" />
          <Select value={selectedShelf} onValueChange={setSelectedShelf}>
            <SelectTrigger className="bg-surface border-border">
              <SelectValue placeholder="All Shelves" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Shelves</SelectItem>
              {shelves.map((shelf) => (
                <SelectItem key={shelf.id} value={shelf.id}>
                  {shelf.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border overflow-x-auto">
        <Table>
          <TableHeader className="bg-surface">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="border-b border-border hover:bg-surface">
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className="text-foreground font-semibold cursor-pointer select-none hover:bg-border/50 transition-colors"
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    <div className="flex items-center gap-2">
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getIsSorted() && (
                        <span className="text-primary">{header.column.getIsSorted() === "desc" ? "↓" : "↑"}</span>
                      )}
                    </div>
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow key={row.id} className="border-b border-border hover:bg-surface/50 transition-colors">
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} className="text-foreground text-sm py-4">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-4">
        <div className="text-sm text-foreground-light text-center sm:text-left">
          Showing {table.getState().pagination.pageIndex * table.getState().pagination.pageSize + 1} to{" "}
          {Math.min(
            (table.getState().pagination.pageIndex + 1) * table.getState().pagination.pageSize,
            filteredBooks.length,
          )}{" "}
          of {table.getFilteredRowModel().rows.length} books
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            className="border-border"
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>

          <div className="text-sm text-foreground-light">
            Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            className="border-border"
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
