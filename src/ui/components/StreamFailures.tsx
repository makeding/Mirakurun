/*
   Copyright 2026 kanreisa

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
import { Button, Callout, Icon, Spinner, Tag } from "@blueprintjs/core";
import { DateTime } from "luxon";
import { StreamFailure } from "../../../api.d";

import "./StreamFailures.sass";

const endpoint = "/api/stream-failures";

function formatDate(value?: number): string | undefined {
    if (!value) { return undefined; }
    return DateTime.fromMillis(value, { zone: "Asia/Tokyo", locale: "ja" }).toFormat("yyyy/LL/dd HH:mm:ss");
}

function formatBytes(value: number): string {
    if (value < 1024) { return `${value} B`; }
    const units = ["KiB", "MiB", "GiB"];
    let amount = value;
    for (const unit of units) {
        amount /= 1024;
        if (amount < 1024 || unit === units[units.length - 1]) {
            return `${amount.toFixed(amount < 10 ? 1 : 0)} ${unit}`;
        }
    }
    return `${value} B`;
}

function failureTitle(failure: StreamFailure): string {
    return [failure.channel, failure.serviceId === undefined ? undefined : `service ${failure.serviceId}`, failure.requestId].filter(Boolean).join(" · ");
}

export const StreamFailures: React.FC = () => {
    const loading = useRef(false);
    const refreshButton = useRef<HTMLButtonElement>(null);
    const retryButton = useRef<HTMLButtonElement>(null);
    const [failures, setFailures] = useState<StreamFailure[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);

    const load = useCallback(async (manual = false) => {
        if (loading.current) { return; }
        loading.current = true;
        if (manual) { setRefreshing(true); }
        try {
            const response = await fetch(endpoint);
            if (!response.ok) {
                throw new Error(`取得に失敗しました (${response.status})`);
            }
            const next = await response.json() as StreamFailure[];
            if (!Array.isArray(next)) {
                throw new Error("応答形式が不正です");
            }
            if (document.activeElement === retryButton.current) {
                refreshButton.current?.focus();
            }
            setFailures(next);
            setError(null);
        } catch (err) {
            const reason = err instanceof Error ? err.message : "取得に失敗しました";
            setError(reason);
        } finally {
            loading.current = false;
            if (manual) { setRefreshing(false); }
        }
    }, []);

    useEffect(() => {
        void load();
        const timer = setInterval(() => { void load(); }, 5000);
        return () => clearInterval(timer);
    }, [load]);

    const initialLoading = failures === null && error === null;
    return (
        <section className="stream-failures" aria-live="polite">
            <div className="stream-failures-heading">
                <h3>最近のストリーム失敗</h3>
                <Button ref={refreshButton} small minimal icon={refreshing ? <Spinner size={16} /> : "refresh"} text="更新"
                    aria-busy={refreshing} aria-disabled={refreshing} onClick={() => void load(true)} />
            </div>
            <div className="stream-failures-pane">
                {error && <Callout className="stream-failures-error" intent="danger" icon="error">
                    <span>更新に失敗しました: {error}</span>
                    <Button ref={retryButton} minimal intent="danger" icon="refresh" text="再試行" aria-disabled={refreshing} onClick={() => void load(true)} />
                    <span>{failures === null ? "接続を確認して、もう一度更新してください。" : "前回取得した結果を表示しています。"}</span>
                </Callout>}
                {initialLoading && <div className="stream-failures-state">
                    <Spinner size={16} />
                    <span>失敗履歴を読み込んでいます</span>
                </div>}
                {failures !== null && failures.length === 0 && <div className="stream-failures-state">
                    <Icon icon="tick-circle" size={16} />
                    <span>最近の失敗はありません</span>
                </div>}
                {failures && failures.length > 0 && <div className="stream-failures-list">
                    {failures.map(failure => <FailureItem key={failure.id} failure={failure} />)}
                </div>}
            </div>
        </section>
    );
};

const FailureItem: React.FC<{ failure: StreamFailure }> = ({ failure }) => {
    const lastInput = formatDate(failure.lastInputAt);
    const lastOutput = formatDate(failure.lastOutputAt);
    return <article className="stream-failure">
        <header>
            <div>
                <strong>{failureTitle(failure)}</strong>
                <time dateTime={new Date(failure.at).toISOString()}>{formatDate(failure.at)}</time>
            </div>
            <Tag intent="danger">{failure.code}</Tag>
        </header>
        <p className="stream-failure-reason">{failure.reason}</p>
        <dl>
            <div><dt>段階</dt><dd>{failure.stage}</dd></div>
            <div><dt>入出力</dt><dd>{formatBytes(failure.inputBytes)} / {formatBytes(failure.outputBytes)}</dd></div>
            {lastInput && <div><dt>最終入力</dt><dd>{lastInput}</dd></div>}
            {lastOutput && <div><dt>最終出力</dt><dd>{lastOutput}</dd></div>}
            {failure.exitCode !== undefined && <div><dt>終了コード</dt><dd>{failure.exitCode}</dd></div>}
            {failure.signal && <div><dt>シグナル</dt><dd>{failure.signal}</dd></div>}
        </dl>
        {failure.stderr && <details>
            <summary>変換器の出力</summary>
            <pre>{failure.stderr}</pre>
        </details>}
    </article>;
};
