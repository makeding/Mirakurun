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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alignment, Button, Card, Dialog, DialogBody, DialogFooter, HTMLSelect, Navbar, NonIdealState, Spinner, Tag } from "@blueprintjs/core";
import { DateTime } from "luxon";
import { GGuideAsset, GGuideBinding, GGuideStatus } from "../../../api.d";
import * as ui from "../modules/ui";

import "./GGuideView.sass";

type AssetFilter = "all" | "displayable" | "unsupported";

function formatDate(value: number): string {
    return DateTime.fromMillis(value).toFormat("yyyy/LL/dd HH:mm:ss");
}

function assetName(asset: GGuideAsset): string {
    return `${asset.mimeType === "image/png" ? "PNG" : "JPEG"} ${asset.width} × ${asset.height}`;
}

function memberDescription(member: GGuideBinding["members"][number], assetIds: Set<string>): string {
    const order = member.order !== undefined ? ` #${member.order}` : "";
    if (member.assetId) {
        return `${member.role}${order}: ${assetIds.has(member.assetId) ? "保存済み素材" : "保存素材なし"}`;
    }
    if (member.uri) {
        return `${member.role}${order}: 外部・未解決参照 ${member.uri}`;
    }
    return `${member.role}${order}: 素材参照なし`;
}

export const GGuideView: React.FC = () => {
    console.debug("routes", "GGuideView");
    ui.setTitle("Hガイド 素材");

    const loading = useRef(false);
    const [assets, setAssets] = useState<GGuideAsset[] | null>(null);
    const [bindings, setBindings] = useState<GGuideBinding[] | null>(null);
    const [status, setStatus] = useState<GGuideStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [bindingsError, setBindingsError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState<boolean>(false);
    const [filter, setFilter] = useState<AssetFilter>("all");
    const [selected, setSelected] = useState<GGuideAsset | null>(null);
    const [brokenImages, setBrokenImages] = useState<Set<string>>(new Set());

    const load = useCallback(async (resetBrokenImageState = false, background = false) => {
        if (loading.current) { return; }
        loading.current = true;
        if (!background) { setRefreshing(true); }
        try {
            const [assetsResponse, statusResponse, bindingsResponse] = await Promise.all([
                fetch("/api/gguide/assets"),
                fetch("/api/gguide"),
                fetch("/api/gguide/bindings")
            ]);
            if (!assetsResponse.ok) {
                throw new Error(`素材を取得できませんでした (${assetsResponse.status})`);
            }
            const nextAssets = await assetsResponse.json() as GGuideAsset[];
            if (!Array.isArray(nextAssets)) {
                throw new Error("素材一覧の形式が不正です");
            }
            setAssets(nextAssets);
            if (resetBrokenImageState) {
                setBrokenImages(new Set());
            }
            if (statusResponse.ok) {
                setStatus(await statusResponse.json() as GGuideStatus);
            }
            if (bindingsResponse.ok) {
                const nextBindings = await bindingsResponse.json() as GGuideBinding[];
                if (Array.isArray(nextBindings)) {
                    setBindings(nextBindings);
                    setBindingsError(null);
                } else {
                    setBindingsError("関連情報の形式が不正です");
                }
            } else {
                setBindingsError(`関連情報を取得できませんでした (${bindingsResponse.status})`);
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

    const filteredAssets = useMemo(() => {
        return (assets || []).filter(asset => filter === "all" || (filter === "displayable" ? asset.displayable : !asset.displayable));
    }, [assets, filter]);

    const isInitialLoading = assets === null && error === null;
    const selectedBindings = useMemo(() => selected ? (bindings || []).filter(binding => binding.members.some(member => member.assetId === selected.id)) : [], [bindings, selected]);
    const assetIds = useMemo(() => new Set((assets || []).map(asset => asset.id)), [assets]);

    return (
        <div className="route" id="route-gguide-view">
            <Navbar className="toolbar">
                <Navbar.Group align={Alignment.START}>
                    <Navbar.Heading>Hガイド 素材</Navbar.Heading>
                    {assets !== null && <span className="asset-count">{filteredAssets.length} / {assets.length} 件</span>}
                </Navbar.Group>
                <Navbar.Group align={Alignment.END}>
                    <Button icon="refresh" text="更新" loading={refreshing} onClick={() => void load(true)} />
                </Navbar.Group>
            </Navbar>

            <div className="content">
                <div className="feedback-slot" aria-live="polite">
                    <div className="material-summary">
                        {status?.collecting && <Tag intent="primary">収集中</Tag>}
                        {status && !status.available && status.keyConfigured && <Tag intent="danger">素材ストア利用不可</Tag>}
                        {status?.error && <Tag intent="danger">{status.error}</Tag>}
                    </div>
                    {error && <div className="bp5-callout bp5-intent-danger fetch-error" role="alert">
                        <strong>素材を更新できませんでした</strong><br />
                        {error}。{assets === null ? "接続を確認して再試行してください。" : "表示中の素材は前回取得分です。"}
                        <Button minimal intent="danger" icon="refresh" text="再試行" onClick={() => void load(true)} />
                    </div>}
                    {bindingsError && <div className="bp5-callout bp5-intent-warning binding-error" role="status">
                        <strong>素材の関連情報を更新できませんでした</strong><br />
                        {bindingsError}。{bindings === null ? "関連情報は表示できません。" : "表示中の紐付けは前回取得分です。"}
                        <Button minimal intent="warning" icon="refresh" text="再試行" onClick={() => void load(true)} />
                    </div>}
                </div>

                {isInitialLoading && <NonIdealState icon={<Spinner />} title="素材を読み込んでいます" />}

                {assets !== null && <>
                    <div className="filters" aria-label="素材の絞り込み">
                        <HTMLSelect value={filter} onChange={event => setFilter(event.target.value as AssetFilter)}>
                            <option value="all">すべて</option>
                            <option value="displayable">表示可能</option>
                            <option value="unsupported">未対応</option>
                        </HTMLSelect>
                    </div>

                    {filteredAssets.length === 0 ? (
                        <NonIdealState
                            icon="media"
                            title={assets.length === 0 ? "保存済み素材はありません" : "条件に合う素材はありません"}
                            description={assets.length === 0 ? "受信した素材がここに表示されます。" : "フィルターを変更してください。"}
                        />
                    ) : (
                        <div className="asset-grid">
                            {filteredAssets.map(asset => {
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
                                        <div className="asset-card-title">{assetName(asset)}</div>
                                        <div className="asset-tags">
                                            <Tag minimal intent={asset.displayable ? "success" : "warning"}>{asset.displayable ? "表示可能" : "未対応"}</Tag>
                                            <Tag minimal>{asset.sources.length} 受信元</Tag>
                                            {bindings && <Tag minimal intent={(bindings.some(binding => binding.members.some(member => member.assetId === asset.id))) ? "primary" : "none"}>
                                                {bindings.filter(binding => binding.members.some(member => member.assetId === asset.id)).length} 関連
                                            </Tag>}
                                        </div>
                                        <div className="asset-meta">{formatDate(asset.lastReceivedAt)}</div>
                                    </div>
                                </Card>;
                            })}
                        </div>
                    )}

                    <section className="binding-overview" aria-labelledby="binding-overview-heading">
                        <h3 id="binding-overview-heading">受信内の関連グループ</h3>
                        {bindings === null ? <p>{bindingsError ? "関連情報を取得できませんでした。再試行してください。" : "関連情報を読み込んでいます。"}</p> :
                            bindings.length === 0 ? <p>保存済みの関連グループはありません。</p> :
                                <div className="binding-overview-list" role="list">
                                    {bindings.map(binding => <Card key={binding.id} className="binding-overview-item" role="listitem">
                                        <strong>{binding.kind.toUpperCase()} / object {binding.objectId}</strong>
                                        <span>{binding.channelType}/{binding.channel}・サービス {binding.serviceId} / {formatDate(binding.lastReceivedAt)}</span>
                                        <ul>
                                            {binding.members.map((member, index) => <li key={`${member.role}:${member.order ?? index}:${member.assetId || member.uri || index}`}>
                                                {memberDescription(member, assetIds)}
                                            </li>)}
                                        </ul>
                                    </Card>)}
                                </div>
                        }
                    </section>
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
                            <tr><th>形式</th><td>{selected.mimeType} ({selected.width} × {selected.height}, {selected.size.toLocaleString()} bytes)</td></tr>
                            <tr><th>受信</th><td>{formatDate(selected.firstReceivedAt)} — {formatDate(selected.lastReceivedAt)}</td></tr>
                            <tr><th>表示可否</th><td>{selected.displayable ? "画像として表示可能。放送での表示可否は未確定です。" : selected.unsupportedReason || "未対応"}</td></tr>
                            <tr><th>素材 ID</th><td className="hash">{selected.id}</td></tr>
                        </tbody></table>
                        <h4>受信元</h4>
                        <div className="source-list">
                            {selected.sources.map((item, index) => <div className="source" key={`${item.moduleHash}:${item.recordOffset}:${index}`}>
                                <strong>{item.channelType}/{item.channel}・サービス {item.serviceId}</strong>
                                <span>{item.moduleName || "名称不明のモジュール"} / record 0x{item.recordType.toString(16)} / {formatDate(item.lastReceivedAt)}</span>
                                <span className="hash">module {item.moduleHash}</span>
                            </div>)}
                        </div>
                        <h4>関連情報</h4>
                        {bindings === null ? <p className="binding-pending">{bindingsError ? "関連情報を取得できませんでした。再試行してください。" : "関連情報を読み込んでいます。"}</p> : selectedBindings.length === 0 ? <p className="binding-pending">この素材に紐付く受信内の参照は見つかっていません。</p> : (
                            <div className="binding-list">
                                {selectedBindings.map(binding => <div className="binding" key={binding.id}>
                                    <strong>{binding.kind.toUpperCase()} / object {binding.objectId}</strong>
                                    <span>{binding.channelType}/{binding.channel}・サービス {binding.serviceId} / {formatDate(binding.lastReceivedAt)}</span>
                                    <div className="binding-members">
                                        {binding.members.map((member, index) => {
                                            const missing = !member.assetId || !assetIds.has(member.assetId);
                                            return <Tag key={`${member.role}:${member.order ?? index}:${member.assetId || member.uri || index}`} minimal intent={missing ? "warning" : "primary"}>
                                                {member.role}{member.order !== undefined ? ` #${member.order}` : ""}{missing ? " (参照未解決)" : ""}{member.uri ? ` [${member.uri}]` : ""}
                                            </Tag>;
                                        })}
                                    </div>
                                </div>)}
                            </div>
                        )}
                    </DialogBody>
                    <DialogFooter actions={<Button text="閉じる" onClick={() => setSelected(null)} />} />
                </>}
            </Dialog>
        </div>
    );
};
