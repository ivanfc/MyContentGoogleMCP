import { type GoogleAdsClient, type Json, assertId } from "../ads/client";

export interface CampaignAssets {
	campaign: { id: string; name: string; type: string };
	byFieldType: Record<string, { resourceName: string; type: string; text?: string; width?: number; height?: number; level: "asset_group" | "campaign"; assetGroup?: string; youtubeVideoId?: string }[]>;
}

/**
 * Assets de un PMax (asset groups) + assets a nivel de campaña (LOGO, BUSINESS_NAME…,
 * que es donde viven si la campaña tiene Brand Guidelines activadas).
 */
export async function getCampaignAssets(client: GoogleAdsClient, cid: string, campaignId: string): Promise<CampaignAssets> {
	const id = assertId(campaignId, "campaign_id");
	const camp = await client.searchAll(cid, `SELECT campaign.id, campaign.name, campaign.advertising_channel_type FROM campaign WHERE campaign.id = ${id}`);
	if (!camp.length) throw new Error(`La campaña ${id} no existe en ${cid}.`);
	const fields =
		"asset.resource_name, asset.type, asset.text_asset.text, asset.image_asset.full_size.width_pixels, asset.image_asset.full_size.height_pixels, asset.youtube_video_asset.youtube_video_id";
	const ag = await client.searchAll(
		cid,
		`SELECT asset_group.name, asset_group_asset.field_type, ${fields} FROM asset_group_asset WHERE campaign.id = ${id} AND asset_group_asset.status != 'REMOVED' AND asset_group.status != 'REMOVED'`,
	);
	const ca = await client.searchAll(
		cid,
		`SELECT campaign.id, campaign_asset.field_type, ${fields} FROM campaign_asset WHERE campaign.id = ${id} AND campaign_asset.status != 'REMOVED'`,
	);
	const byFieldType: CampaignAssets["byFieldType"] = {};
	const push = (ft: string, r: Json, level: "asset_group" | "campaign", assetGroup?: string) => {
		const a = r.asset;
		const list = (byFieldType[ft] ??= []);
		if (list.some((x) => x.resourceName === a.resourceName)) return;
		list.push({
			resourceName: a.resourceName,
			type: a.type,
			text: a.textAsset?.text,
			width: a.imageAsset?.fullSize?.widthPixels ? Number(a.imageAsset.fullSize.widthPixels) : undefined,
			height: a.imageAsset?.fullSize?.heightPixels ? Number(a.imageAsset.fullSize.heightPixels) : undefined,
			youtubeVideoId: a.youtubeVideoAsset?.youtubeVideoId,
			level,
			assetGroup,
		});
	};
	for (const r of ag) push(r.assetGroupAsset.fieldType, r, "asset_group", r.assetGroup?.name);
	for (const r of ca) push(r.campaignAsset.fieldType, r, "campaign");
	const c = camp[0].campaign;
	return { campaign: { id: String(c.id), name: c.name, type: c.advertisingChannelType }, byFieldType };
}
