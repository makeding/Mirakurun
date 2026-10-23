/*
   Copyright 2026 huggy

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/
import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alignment, Button, Card, Dialog, DialogBody, DialogFooter, Navbar, NonIdealState, Spinner, Tag } from "@blueprintjs/core";
import { DateTime } from "luxon";
import { GGuideAsset, GGuideStatus } from "../../../api.d";
import * as ui from "../modules/ui";

import "./GGuideView.sass";

function formatDate(value: number): string {
    return DateTime.fromMillis(value, { zone: "Asia/Tokyo", locale: "ja" }).toFormat("yyyy/LL/dd HH:mm:ss");
}

function assetName(asset: GGuideAsset): string {
    return `${asset.mimeType === "image/png" ? "PNG" : "JPEG"} ${asset.width} × ${asset.height}`;
}

export const GGuideView: React.FC = () => {
    console.debug("routes", "GGuideView");
    ui.setTitle("Hガイド Collection");

    const loading = useRef(false);
    const [assets, setAssets] = useState<GGuideAsset[] | null>(null);
    const [status, setStatus] = useState<GGuideStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState<boolean>(false);
    const [selected, setSelected] = useState<GGuideAsset | null>(null);
    const [brokenImages, setBrokenImages] = useState<Set<string>>(new Set());

    const load = useCallback(async (resetBrokenImageState = false, background = false) => {
        if (loading.current) { return; }
        loading.current = true;
        if (!background) { setRefreshing(true); }
        try {
            const [assetsResponse, statusResponse] = await Promise.all([
                fetch("/api/gguide/assets"),
                fetch("/api/gguide")
            ]);
            if (!assetsResponse.ok) {
                throw new Error(`素材を取得できませんでした (${assetsResponse.status})`);
            }
            const nextAssets = await assetsResponse.json() as GGuideAsset[];
            if (!Array.isArray(nextAssets)) {
                throw new Error("素材一覧の形式が不正です");
            }
            setAssets(nextAssets);
            setSelected(previous => previous ? nextAssets.find(asset => asset.id === previous.id) || previous : null);
            if (resetBrokenImageState) {
                setBrokenImages(new Set());
            }
            if (statusResponse.ok) {
                setStatus(await statusResponse.json() as GGuideStatus);
            }
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : "素材を取得できませんでした");
        } finally {
            loading.current = false;
            if (!background) { setRefreshing(false); }
        }
    }, []);

    useEffect(() => {
        void load();
        const timer = setInterval(() => { void load(false, true); }, 5000);
        return () => clearInterval(timer);
    }, [load]);

    const isInitialLoading = assets === null && error === null;

    return (
        <div className="route" id="route-gguide-view">
            <Navbar className="toolbar">
                <Navbar.Group align={Alignment.START}>
                    <Navbar.Heading>Hガイド Collection</Navbar.Heading>
                    {assets !== null && <span className="asset-count">{assets.length} 件</span>}
                    {status?.collecting && <Tag className="collection-status" intent="primary">収集中</Tag>}
                </Navbar.Group>
                <Navbar.Group align={Alignment.END}>
                    <Button icon="refresh" text="更新" loading={refreshing} onClick={() => void load(true)} />
                </Navbar.Group>
            </Navbar>

            <div className="content">
                {(error || status?.error || (status && !status.available && status.keyConfigured)) && <div className="feedback-slot" aria-live="polite">
                    <div className="material-summary">
                        {status && !status.available && status.keyConfigured && <Tag intent="danger">素材ストア利用不可</Tag>}
                        {status?.error && <Tag intent="danger">{status.error}</Tag>}
                    </div>
                    {error && <div className="bp5-callout bp5-intent-danger fetch-error" role="alert">
                        <strong>素材を更新できませんでした</strong><br />
                        {error}。{assets === null ? "接続を確認して再試行してください。" : "表示中の素材は前回取得分です。"}
                        <Button minimal intent="danger" icon="refresh" text="再試行" onClick={() => void load(true)} />
                    </div>}

                </div>}

                {isInitialLoading && <NonIdealState icon={<Spinner />} title="素材を読み込んでいます" />}

                {assets !== null && <>
                    {assets.length === 0 ? (
                        <NonIdealState
                            icon="media"
                            title="保存済み素材はありません"
                            description="受信した素材がここに表示されます。"
                        />
                    ) : (
                        <div className="asset-grid">
                            {assets.map(asset => {
                                const imageUnavailable = !asset.displayable || brokenImages.has(asset.id);
                                return <Card interactive key={asset.id} className="asset-card" role="button" aria-haspopup="dialog" aria-label={`${assetName(asset)} の詳細を開く`} onClick={() => setSelected(asset)} tabIndex={0} onKeyDown={event => {
                                    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(asset); }
                                }}>
                                    <div className="asset-thumbnail">
                                        {imageUnavailable ? <div className="thumbnail-unavailable">
                                            <span className="bp5-icon bp5-icon-media" />
                                            <span>{asset.unsupportedReason === "missing-palette" ? "外部パレット待ち" : "プレビュー不可"}</span>
                                        </div> : <img src={`/api/gguide/assets/${encodeURIComponent(asset.id)}`} alt="" loading="lazy" onError={() => setBrokenImages(previous => new Set(previous).add(asset.id))} />}
                                    </div>
                                    <div className="asset-card-body">
                                        <div className="asset-card-title">{[...new Set(asset.programs?.map(program => program.name).filter(Boolean))].join(" / ") || "番組名未取得"}</div>
                                        <div className="asset-tags">
                                            <span>{[...new Set(asset.programs?.map(program => program.channelName).filter(Boolean))].join(" / ") || "放送局未取得"}</span>

                                        </div>
                                        <div className="asset-meta">{formatDate(asset.lastReceivedAt)}</div>
                                    </div>
                                </Card>;
                            })}
                        </div>
                    )}


                </>}
            </div>

            <Dialog className="asset-dialog" isOpen={selected !== null} onClose={() => setSelected(null)} title={selected && assetName(selected)}>
                {selected && <>
                    <DialogBody>
                        <div className="asset-preview">
                            {selected.displayable && !brokenImages.has(selected.id)
                                ? <img src={`/api/gguide/assets/${encodeURIComponent(selected.id)}`} alt={assetName(selected)} onError={() => setBrokenImages(previous => new Set(previous).add(selected.id))} />
                                : <div className="thumbnail-unavailable"><span className="bp5-icon bp5-icon-media" />{selected.unsupportedReason === "missing-palette" ? "外部パレットが未取得です" : "この素材はプレビューできません"}</div>}
                        </div>
                        <table className="bp5-html-table bp5-html-table-condensed asset-details"><tbody>
                            <tr><th>番組</th><td>{selected.programs?.length ? selected.programs.map(program => <div key={`${program.networkId}:${program.serviceId}:${program.programGgid}`} className="asset-program">
                                <strong>{program.channelName || "放送局名未取得"}</strong>
                                <div>{program.name || "番組名未取得"}</div>
                                {program.startAt !== undefined && <div>{formatDate(program.startAt)}{program.duration !== undefined && ` — ${formatDate(program.startAt + program.duration)}`}</div>}
                            </div>) : "未取得"}</td></tr>
                            <tr><th>形式</th><td>{selected.mimeType} ({selected.width} × {selected.height}, {selected.size.toLocaleString()} bytes)</td></tr>
                            <tr><th>受信</th><td>{formatDate(selected.firstReceivedAt)} — {formatDate(selected.lastReceivedAt)}</td></tr>
                        </tbody></table>
                    </DialogBody>
                    <DialogFooter actions={<Button text="閉じる" onClick={() => setSelected(null)} />} />
                </>}
            </Dialog>
        </div>
    );
};
