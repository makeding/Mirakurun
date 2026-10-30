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
import { useState, useEffect } from "react";
import {
    Alignment,
    Breadcrumbs,
    Button,
    Checkbox,
    Dialog,
    DialogBody,
    DialogFooter,
    FormGroup,
    InputGroup,
    Navbar,
    NonIdealState,
    Spinner,
    Switch,
    HTMLTable
} from "@blueprintjs/core";
import equal from "fast-deep-equal";
import { validateDvbConfig } from "../../DvbConfig";
import { state } from "../modules/state";
import * as ui from "../modules/ui";
import { ConfigTuners, ConfigTunersItem, ChannelType } from "../../../api.d";

import "./TunersConfigView.sass";

const configAPI = "/api/config/tuners";
const typesIndex = ["GR", "GR-ALT", "BS", "CS", "SKY", "BS4K"];

function sortTypes(types: ChannelType[]): ChannelType[] {
    return types.sort((a, b) => typesIndex.indexOf(a) - typesIndex.indexOf(b));
}

export const TunersConfigView: React.FC = () => {
    console.debug("routes", "TunersConfigView");

    const [current, setCurrent] = useState<ConfigTuners | null>(null);
    const [editing, setEditing] = useState<ConfigTuners | null>(null);
    const [showSaveDialog, setShowSaveDialog] = useState(false);
    const [saved, setSaved] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    ui.setTitle("チューナー設定", isLoading);

    useEffect(() => {
        if (saved === true) {
            setTimeout(() => {
                // Restart notification will be emitted in production when requested
            }, 500);
            setSaved(false);
            return;
        }

        (async () => {
            try {
                const res = await (await fetch(configAPI)).json();
                console.log("TunersConfigView", "GET", configAPI, "->", res);
                setEditing(JSON.parse(JSON.stringify(res)));
                setCurrent(JSON.parse(JSON.stringify(res)));
                setIsLoading(false);
            } catch (e) {
                console.error(e);
                setIsLoading(false);
            }
        })();
    }, [saved]);

    const hasChanges = editing !== null && current !== null && !equal(editing, current);
    const configError = editing?.map((tuner, i) => {
        const error = validateDvbConfig(tuner);
        return error ? `Tuner #${i}: ${error}` : null;
    }).find(error => error !== null);

    const handleCancel = () => {
        setSaveError(null);
        if (current) {
            setEditing(JSON.parse(JSON.stringify(current)));
        }
    };

    const handleSave = async () => {
        if (!editing || saving) {
            return;
        }

        setSaving(true);
        setSaveError(null);
        setShowSaveDialog(false);
        try {
            console.log("TunersConfigView", "PUT", configAPI, "<-", editing);
            const response = await fetch(configAPI, {
                method: "PUT",
                headers: { "Content-Type": "application/json; charset=utf-8" },
                body: JSON.stringify(editing)
            });
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.reason || `HTTP ${response.status}`);
            }
            setSaved(true);
        } catch (err) {
            console.error(err);
            setSaveError(`Save failed: ${err.message}. Correct the configuration and save again.`);
        } finally {
            setSaving(false);
        }
    };

    const handleAddTuner = () => {
        if (!editing) return;
        const i = editing.length;
        const newTuner: ConfigTunersItem = {
            name: `adapter${i}`,
            types: [],
            command: "dvbv5-zap -a <dvbAdapter> -f <dvbFrontend> -c ./config/dvbconf-for-isdb/conf/dvbv5_channels_isdbs.conf -r -P -o - <channel>",
            dvbAutoDiscovery: true,
            decoder: "arib-b25-stream-test",
            mmtsDecoder: "dantto4k - -",
            isDisabled: true
        };
        setEditing([...editing, newTuner]);
    };

    const updateTuner = (index: number, updated: Partial<ConfigTunersItem>) => {
        if (!editing) return;
        const newEditing = [...editing];
        newEditing[index] = { ...newEditing[index], ...updated };
        setEditing(newEditing);
    };

    const deleteTunerProperty = (index: number, key: keyof ConfigTunersItem) => {
        if (!editing) return;
        const newEditing = [...editing];
        const updated = { ...newEditing[index] };
        delete updated[key];
        newEditing[index] = updated;
        setEditing(newEditing);
    };

    const handleUp = (i: number) => {
        if (!editing || i === 0) return;
        const newEditing = [...editing];
        const temp = newEditing[i];
        newEditing[i] = newEditing[i - 1];
        newEditing[i - 1] = temp;
        setEditing(newEditing);
    };

    const handleDown = (i: number) => {
        if (!editing || i === editing.length - 1) return;
        const newEditing = [...editing];
        const temp = newEditing[i];
        newEditing[i] = newEditing[i + 1];
        newEditing[i + 1] = temp;
        setEditing(newEditing);
    };

    const handleRemove = (i: number) => {
        if (!editing) return;
        const newEditing = [...editing];
        newEditing.splice(i, 1);
        setEditing(newEditing);
    };

    const toolbar = (
        <Navbar className="toolbar">
            <Navbar.Group align={Alignment.START}>
                <Navbar.Heading>
                    <Breadcrumbs items={[
                        {
                            text: "チューナー設定"
                        }
                    ]} />
                </Navbar.Heading>
            </Navbar.Group>

            <Navbar.Group align={Alignment.END}>
                <Button
                    minimal
                    intent="success"
                    icon="add"
                    text="Add Tuner"
                    disabled={saving}
                    onClick={handleAddTuner}
                />

                <Navbar.Divider />

                <Button
                    minimal
                    intent="danger"
                    icon="undo"
                    text="Cancel"
                    disabled={!hasChanges || saving}
                    onClick={handleCancel}
                />
                <Button
                    intent="primary"
                    icon="saved"
                    text="Save"
                    disabled={!hasChanges || saving || !!configError}
                    onClick={() => setShowSaveDialog(true)}
                />
            </Navbar.Group>
        </Navbar>
    );

    if (isLoading || !editing) {
        return (
            <div className="route" id="route-tuners-config-view">
                {toolbar}
                <NonIdealState
                    icon={<Spinner />}
                    title="ロード中"
                    description="設定を読み込んでいます..."
                />
            </div>
        );
    }

    return (
        <div className="route" id="route-tuners-config-view">
            {toolbar}

            <div className="content">
                <div className="tuner-config-status" role="status">
                    {saving ? "Saving..." : (configError || saveError)}
                </div>
                <fieldset className="tuner-fields" disabled={saving}>
                <HTMLTable className="tuner-table" striped interactive>
                    <thead>
                        <tr>
                            <th style={{ width: "80px" }}>Enable</th>
                            <th style={{ width: "180px" }}>Name</th>
                            <th style={{ width: "120px" }}>Types</th>
                            <th>Options</th>
                            <th style={{ width: "140px", textAlign: "right" }}></th>
                        </tr>
                    </thead>
                    <tbody>
                        {editing.map((tuner, i) => (
                            <tr key={i}>
                                <td>
                                    <Switch
                                        checked={!tuner.isDisabled}
                                        onChange={(e) => {
                                            updateTuner(i, { isDisabled: !e.currentTarget.checked });
                                        }}
                                    />
                                </td>
                                <td>
                                    <InputGroup
                                        value={tuner.name || ""}
                                        onChange={(e) => {
                                            updateTuner(i, { name: e.target.value });
                                        }}
                                    />
                                </td>
                                <td>
                                    <div className="types-checkboxes">
                                        {(["GR", "GR-ALT", "BS", "CS", "SKY", "BS4K"] as ChannelType[]).map((type) => {
                                            const checked = tuner.types?.includes(type) ?? false;
                                            return (
                                                <Checkbox
                                                    key={type}
                                                    label={type}
                                                    checked={checked}
                                                    inline
                                                    onChange={(e) => {
                                                        let newTypes = [...(tuner.types || [])];
                                                        if (e.currentTarget.checked) {
                                                            newTypes.push(type);
                                                            newTypes = sortTypes(newTypes);
                                                        } else {
                                                            newTypes = newTypes.filter(t => t !== type);
                                                        }
                                                        updateTuner(i, { types: newTypes });
                                                    }}
                                                />
                                            );
                                        })}
                                    </div>
                                </td>
                                <td>
                                    <div className="tuner-options-grid">
                                        <FormGroup label="Group" labelFor={`tuner-group-${i}`}>
                                            <InputGroup
                                                id={`tuner-group-${i}`}
                                                value={tuner.group || ""}
                                                placeholder="Automatic"
                                                onChange={(e) => {
                                                    const value = e.target.value;
                                                    if (value === "") {
                                                        deleteTunerProperty(i, "group");
                                                    } else {
                                                        updateTuner(i, { group: value });
                                                    }
                                                }}
                                            />
                                        </FormGroup>
                                        {!tuner.remoteMirakurunHost && (
                                            <>
                                                <FormGroup label="Command">
                                                    <InputGroup
                                                        value={tuner.command || ""}
                                                        onChange={(e) => {
                                                            const val = e.target.value;
                                                            if (val === "") {
                                                                deleteTunerProperty(i, "command");
                                                            } else {
                                                                updateTuner(i, { command: val });
                                                            }
                                                        }}
                                                    />
                                                </FormGroup>
                                                {tuner.types?.includes("BS4K") && (
                                                    <FormGroup
                                                        label="BS4K Command"
                                                        helperText="Falls back to Command when empty."
                                                    >
                                                        <InputGroup
                                                            value={tuner.commandBS4K || ""}
                                                            onChange={(e) => {
                                                                const val = e.target.value;
                                                                if (val === "") {
                                                                    deleteTunerProperty(i, "commandBS4K");
                                                                } else {
                                                                    updateTuner(i, { commandBS4K: val });
                                                                }
                                                            }}
                                                        />
                                                    </FormGroup>
                                                )}
                                                <Checkbox
                                                    label="DVB frontend selection"
                                                    checked={tuner.dvbAutoDiscovery === true}
                                                    onChange={(e) => {
                                                        updateTuner(i, {
                                                            dvbAutoDiscovery: e.currentTarget.checked,
                                                            ...(!e.currentTarget.checked ? { dvbFrontendPath: undefined } : {})
                                                        });
                                                    }}
                                                />
                                                <FormGroup label="DVB Frontend Path">
                                                    <InputGroup
                                                        value={tuner.dvbFrontendPath || ""}
                                                        disabled={tuner.dvbAutoDiscovery !== true}
                                                        placeholder="Automatic"
                                                        onChange={(e) => {
                                                            const val = e.target.value;
                                                            if (val === "") {
                                                                deleteTunerProperty(i, "dvbFrontendPath");
                                                            } else {
                                                                updateTuner(i, { dvbFrontendPath: val });
                                                            }
                                                        }}
                                                    />
                                                </FormGroup>
                                                <FormGroup label="DVB Device Path">
                                                    <InputGroup
                                                        value={tuner.dvbDevicePath || ""}
                                                        onChange={(e) => {
                                                            const val = e.target.value;
                                                            if (val === "") {
                                                                deleteTunerProperty(i, "dvbDevicePath");
                                                            } else {
                                                                updateTuner(i, { dvbDevicePath: val });
                                                            }
                                                        }}
                                                    />
                                                </FormGroup>
                                                <FormGroup
                                                    label="Check Device Path"
                                                    helperText="Falls back to DVB Device Path when empty."
                                                >
                                                    <InputGroup
                                                        value={tuner.checkDevicePath || ""}
                                                        onChange={(e) => {
                                                            const val = e.target.value;
                                                            if (val === "") {
                                                                deleteTunerProperty(i, "checkDevicePath");
                                                            } else {
                                                                updateTuner(i, { checkDevicePath: val });
                                                            }
                                                        }}
                                                    />
                                                </FormGroup>
                                            </>
                                        )}
                                        {!tuner.command && (
                                            <>
                                                <div className="remote-mirakurun-group">
                                                    <FormGroup label="Remote Mirakurun Host" style={{ flex: 1 }}>
                                                        <InputGroup
                                                            value={tuner.remoteMirakurunHost || ""}
                                                            onChange={(e) => {
                                                                const val = e.target.value;
                                                                if (val === "") {
                                                                    deleteTunerProperty(i, "remoteMirakurunHost");
                                                                } else if (/^[0-9a-z\.]+$/.test(val)) {
                                                                    updateTuner(i, { remoteMirakurunHost: val });
                                                                }
                                                            }}
                                                        />
                                                    </FormGroup>
                                                    <FormGroup label="Port" style={{ width: "90px" }}>
                                                        <InputGroup
                                                            placeholder="40772"
                                                            value={`${tuner.remoteMirakurunPort || ""}`}
                                                            onChange={(e) => {
                                                                const val = e.target.value;
                                                                if (val === "") {
                                                                    deleteTunerProperty(i, "remoteMirakurunPort");
                                                                } else if (/^[0-9]+$/.test(val)) {
                                                                    const port = parseInt(val, 10);
                                                                    if (port <= 65535 && port > 0) {
                                                                        updateTuner(i, { remoteMirakurunPort: port });
                                                                    }
                                                                }
                                                            }}
                                                        />
                                                    </FormGroup>
                                                </div>
                                                <div style={{ marginBottom: "8px" }}>
                                                    <Checkbox
                                                        label="Decode (Remote Mirakurun Decoder)"
                                                        checked={tuner.remoteMirakurunDecoder || false}
                                                        onChange={(e) => {
                                                            if (e.currentTarget.checked) {
                                                                updateTuner(i, { remoteMirakurunDecoder: true });
                                                            } else {
                                                                deleteTunerProperty(i, "remoteMirakurunDecoder");
                                                            }
                                                        }}
                                                    />
                                                    <Checkbox
                                                        label="Allow Nested Remote Tuner"
                                                        checked={tuner.remoteMirakurunAllowNested || false}
                                                        onChange={(e) => {
                                                            if (e.currentTarget.checked) {
                                                                updateTuner(i, { remoteMirakurunAllowNested: true });
                                                            } else {
                                                                deleteTunerProperty(i, "remoteMirakurunAllowNested");
                                                            }
                                                        }}
                                                    />
                                                </div>
                                            </>
                                        )}
                                        {(!tuner.remoteMirakurunHost || !tuner.remoteMirakurunDecoder) && (
                                            <FormGroup label="Decoder">
                                                <InputGroup
                                                    value={tuner.decoder || ""}
                                                    onChange={(e) => {
                                                        const val = e.target.value;
                                                        if (val === "") {
                                                            deleteTunerProperty(i, "decoder");
                                                        } else {
                                                            updateTuner(i, { decoder: val });
                                                        }
                                                    }}
                                                />
                                            </FormGroup>
                                        )}
                                        {!tuner.remoteMirakurunHost && tuner.types?.includes("BS4K") && (
                                            <FormGroup label="MMTS Decoder">
                                                <InputGroup
                                                    value={tuner.mmtsDecoder || ""}
                                                    onChange={(e) => {
                                                        const val = e.target.value;
                                                        if (val === "") {
                                                            deleteTunerProperty(i, "mmtsDecoder");
                                                        } else {
                                                            updateTuner(i, { mmtsDecoder: val });
                                                        }
                                                    }}
                                                />
                                            </FormGroup>
                                        )}
                                    </div>
                                </td>
                                <td>
                                    <div className="controls-cell">
                                        <Button
                                            disabled={i === 0}
                                            icon="chevron-up"
                                            onClick={() => handleUp(i)}
                                            minimal
                                        />
                                        <Button
                                            disabled={i === editing.length - 1}
                                            icon="chevron-down"
                                            onClick={() => handleDown(i)}
                                            minimal
                                        />
                                        <Button
                                            icon="trash"
                                            intent="danger"
                                            onClick={() => handleRemove(i)}
                                            minimal
                                        />
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </HTMLTable>
                </fieldset>
            </div>

            {/* Save Confirmation Dialog */}
            <Dialog
                isOpen={showSaveDialog}
                onClose={() => setShowSaveDialog(false)}
                title="Save"
            >
                <DialogBody>
                    <p>設定を保存しますか？</p>
                    <p className="bp5-text-muted">適用するには再起動が必要です。</p>
                </DialogBody>
                <DialogFooter
                    actions={
                        <>
                            <Button onClick={() => setShowSaveDialog(false)}>キャンセル</Button>
                            <Button
                                intent="primary"
                                disabled={!hasChanges || saving || !!configError}
                                onClick={handleSave}
                            >
                                保存
                            </Button>
                        </>
                    }
                />
            </Dialog>
        </div>
    );
};
