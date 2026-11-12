import { SharedViewerClient } from '../../../components/SharedViewerClient';

export const dynamic = 'force-dynamic';

export default async function SharedDesignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SharedViewerClient token={token} />;
}
