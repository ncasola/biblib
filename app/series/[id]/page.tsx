import { SeriesDetailScreen } from "@/components/series-detail-screen"

export default async function SeriesDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <SeriesDetailScreen seriesId={id} />
}
