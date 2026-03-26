"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractGroupMetadata = exports.makeGroupsSocket = void 0;

const WAProto_1 = require("../../WAProto");
const Types_1 = require("../Types");
const Utils_1 = require("../Utils");
const WABinary_1 = require("../WABinary");
const chats_1 = require("./chats");

// استيراد NodeCache
const NodeCache = require('node-cache');

const makeGroupsSocket = (config) => {
    const sock = (0, chats_1.makeChatsSocket)(config);
    const { authState, ev, query, upsertMessage } = sock;
    
    // تهيئة الكاش إذا لم يتم توفيره في config
    const groupCache = config.cachedGroupMetadata || new NodeCache({ stdTTL: 5 * 60, useClones: false });
    
    const groupQuery = async (jid, type, content) => (query({
        tag: 'iq',
        attrs: {
            type,
            xmlns: 'w:g2',
            to: jid,
        },
        content
    }));

    const groupMetadata = async (jid) => {
        // التحقق من وجود البيانات في الكاش أولاً
        let metadata = groupCache.get(jid);
        
        if (metadata) {
            return metadata;
        }
        
        // إذا لم تكن موجودة، جلبها من الخادم
        const result = await groupQuery(jid, 'get', [{ tag: 'query', attrs: { request: 'interactive' } }]);
        metadata = (0, exports.extractGroupMetadata)(result);
        
        // تخزين في الكاش
        groupCache.set(jid, metadata);
        
        return metadata;
    };
    
    // دالة لتحديث الكاش لمجموعة محددة
    const updateGroupCache = async (jid) => {
        try {
            const metadata = await groupMetadata(jid);
            groupCache.set(jid, metadata);
            return metadata;
        } catch (error) {
            console.error(`Failed to update cache for group ${jid}:`, error);
            return null;
        }
    };
    
    // دالة لحذف مجموعة من الكاش
    const deleteGroupCache = (jid) => {
        groupCache.del(jid);
    };
    
    // دالة لتنظيف الكاش بالكامل
    const clearGroupCache = () => {
        groupCache.flushAll();
    };
    
    // دالة لجلب جميع المجموعات مع تحديث الكاش
    const groupFetchAllParticipating = async () => {
        const result = await query({
            tag: 'iq',
            attrs: {
                to: '@g.us',
                xmlns: 'w:g2',
                type: 'get',
            },
            content: [
                {
                    tag: 'participating',
                    attrs: {},
                    content: [
                        { tag: 'participants', attrs: {} },
                        { tag: 'description', attrs: {} }
                    ]
                }
            ]
        });
        
        const data = {};
        const groupsChild = (0, WABinary_1.getBinaryNodeChild)(result, 'groups');
        
        if (groupsChild) {
            const groups = (0, WABinary_1.getBinaryNodeChildren)(groupsChild, 'group');
            for (const groupNode of groups) {
                const meta = (0, exports.extractGroupMetadata)({
                    tag: 'result',
                    attrs: {},
                    content: [groupNode]
                });
                data[meta.id] = meta;
                // تحديث الكاش لكل مجموعة
                groupCache.set(meta.id, meta);
            }
        }
        
        sock.ev.emit('groups.update', Object.values(data));
        return data;
    };
    
    // مراقبة الأحداث لتحديث الكاش تلقائياً
    sock.ws.on('CB:ib,,dirty', async (node) => {
        const { attrs } = (0, WABinary_1.getBinaryNodeChild)(node, 'dirty');
        if (attrs.type !== 'groups') {
            return;
        }
        await groupFetchAllParticipating();
        await sock.cleanDirtyBits('groups');
    });
    
    // إضافة مستمع للأحداث لتحديث الكاش
    ev.on('groups.update', async (updates) => {
        for (const update of updates) {
            if (update.id) {
                // تحديث الكاش بالبيانات الجديدة
                await updateGroupCache(update.id);
            }
        }
    });
    
    ev.on('group-participants.update', async (update) => {
        if (update.id) {
            // تحديث الكاش عند تغيير المشاركين
            await updateGroupCache(update.id);
        }
    });
    
    ev.on('chats.update', async (updates) => {
        for (const update of updates) {
            if (update.id && update.id.endsWith('@g.us')) {
                // تحديث الكاش للمجموعات عند تحديث الدردشات
                await updateGroupCache(update.id);
            }
        }
    });
    
    return {
        ...sock,
        groupQuery,
        groupMetadata,
        updateGroupCache,
        deleteGroupCache,
        clearGroupCache,
        groupFetchAllParticipating,
        groupCreate: async (subject, participants) => {
            const key = (0, Utils_1.generateMessageIDV2)();
            const result = await groupQuery('@g.us', 'set', [
                {
                    tag: 'create',
                    attrs: {
                        subject,
                        key
                    },
                    content: participants.map(jid => ({
                        tag: 'participant',
                        attrs: { jid }
                    }))
                }
            ]);
            const metadata = (0, exports.extractGroupMetadata)(result);
            // تخزين المجموعة الجديدة في الكاش
            groupCache.set(metadata.id, metadata);
            return metadata;
        },
        groupLeave: async (id) => {
            await groupQuery('@g.us', 'set', [
                {
                    tag: 'leave',
                    attrs: {},
                    content: [
                        { tag: 'group', attrs: { id } }
                    ]
                }
            ]);
            // حذف المجموعة من الكاش عند المغادرة
            deleteGroupCache(id);
        },
        groupUpdateSubject: async (jid, subject) => {
            await groupQuery(jid, 'set', [
                {
                    tag: 'subject',
                    attrs: {},
                    content: Buffer.from(subject, 'utf-8')
                }
            ]);
            // تحديث الكاش بعد تغيير الاسم
            await updateGroupCache(jid);
        },
        groupRequestParticipantsList: async (jid) => {
            const result = await groupQuery(jid, 'get', [
                {
                    tag: 'membership_approval_requests',
                    attrs: {}
                }
            ]);
            const node = (0, WABinary_1.getBinaryNodeChild)(result, 'membership_approval_requests');
            const participants = (0, WABinary_1.getBinaryNodeChildren)(node, 'membership_approval_request');
            return participants.map(v => v.attrs);
        },
        groupRequestParticipantsUpdate: async (jid, participants, action) => {
            const result = await groupQuery(jid, 'set', [{
                    tag: 'membership_requests_action',
                    attrs: {},
                    content: [
                        {
                            tag: action,
                            attrs: {},
                            content: participants.map(jid => ({
                                tag: 'participant',
                                attrs: { jid }
                            }))
                        }
                    ]
                }]);
            const node = (0, WABinary_1.getBinaryNodeChild)(result, 'membership_requests_action');
            const nodeAction = (0, WABinary_1.getBinaryNodeChild)(node, action);
            const participantsAffected = (0, WABinary_1.getBinaryNodeChildren)(nodeAction, 'participant');
            
            // تحديث الكاش بعد تغيير الطلبات
            await updateGroupCache(jid);
            
            return participantsAffected.map(p => {
                return { status: p.attrs.error || '200', jid: p.attrs.jid };
            });
        },
        groupParticipantsUpdate: async (jid, participants, action) => {
            const result = await groupQuery(jid, 'set', [
                {
                    tag: action,
                    attrs: {},
                    content: participants.map(jid => ({
                        tag: 'participant',
                        attrs: { jid }
                    }))
                }
            ]);
            const node = (0, WABinary_1.getBinaryNodeChild)(result, action);
            const participantsAffected = (0, WABinary_1.getBinaryNodeChildren)(node, 'participant');
            
            // تحديث الكاش بعد تغيير المشاركين
            await updateGroupCache(jid);
            
            return participantsAffected.map(p => {
                return { status: p.attrs.error || '200', jid: p.attrs.jid, content: p };
            });
        },
        groupUpdateDescription: async (jid, description) => {
            var _a;
            const metadata = await groupMetadata(jid);
            const prev = (_a = metadata.descId) !== null && _a !== void 0 ? _a : null;
            await groupQuery(jid, 'set', [
                {
                    tag: 'description',
                    attrs: {
                        ...(description ? { id: (0, Utils_1.generateMessageIDV2)() } : { delete: 'true' }),
                        ...(prev ? { prev } : {})
                    },
                    content: description ? [
                        { tag: 'body', attrs: {}, content: Buffer.from(description, 'utf-8') }
                    ] : undefined
                }
            ]);
            // تحديث الكاش بعد تغيير الوصف
            await updateGroupCache(jid);
        },
        groupInviteCode: async (jid) => {
            const result = await groupQuery(jid, 'get', [{ tag: 'invite', attrs: {} }]);
            const inviteNode = (0, WABinary_1.getBinaryNodeChild)(result, 'invite');
            return inviteNode === null || inviteNode === void 0 ? void 0 : inviteNode.attrs.code;
        },
        groupRevokeInvite: async (jid) => {
            const result = await groupQuery(jid, 'set', [{ tag: 'invite', attrs: {} }]);
            const inviteNode = (0, WABinary_1.getBinaryNodeChild)(result, 'invite');
            return inviteNode === null || inviteNode === void 0 ? void 0 : inviteNode.attrs.code;
        },
        groupAcceptInvite: async (code) => {
            const results = await groupQuery('@g.us', 'set', [{ tag: 'invite', attrs: { code } }]);
            const result = (0, WABinary_1.getBinaryNodeChild)(results, 'group');
            const groupId = result === null || result === void 0 ? void 0 : result.attrs.jid;
            
            // تحديث الكاش للمجموعة الجديدة
            if (groupId) {
                await updateGroupCache(groupId);
            }
            
            return groupId;
        },
        groupRevokeInviteV4: async (groupJid, invitedJid) => {
            const result = await groupQuery(groupJid, 'set', [{ tag: 'revoke', attrs: {}, content: [{ tag: 'participant', attrs: { jid: invitedJid } }] }]);
            
            // تحديث الكاش بعد إلغاء الدعوة
            await updateGroupCache(groupJid);
            
            return !!result;
        },
        groupAcceptInviteV4: ev.createBufferedFunction(async (key, inviteMessage) => {
            var _a;
            key = typeof key === 'string' ? { remoteJid: key } : key;
            const results = await groupQuery(inviteMessage.groupJid, 'set', [{
                    tag: 'accept',
                    attrs: {
                        code: inviteMessage.inviteCode,
                        expiration: inviteMessage.inviteExpiration.toString(),
                        admin: key.remoteJid
                    }
                }]);
            
            if (key.id) {
                inviteMessage = WAProto_1.proto.Message.GroupInviteMessage.fromObject(inviteMessage);
                inviteMessage.inviteExpiration = 0;
                inviteMessage.inviteCode = '';
                ev.emit('messages.update', [
                    {
                        key,
                        update: {
                            message: {
                                groupInviteMessage: inviteMessage
                            }
                        }
                    }
                ]);
            }
            
            await upsertMessage({
                key: {
                    remoteJid: inviteMessage.groupJid,
                    id: (0, Utils_1.generateMessageIDV2)((_a = sock.user) === null || _a === void 0 ? void 0 : _a.id),
                    fromMe: false,
                    participant: key.remoteJid,
                },
                messageStubType: Types_1.WAMessageStubType.GROUP_PARTICIPANT_ADD,
                messageStubParameters: [
                    authState.creds.me.id
                ],
                participant: key.remoteJid,
                messageTimestamp: (0, Utils_1.unixTimestampSeconds)()
            }, 'notify');
            
            // تحديث الكاش للمجموعة
            await updateGroupCache(inviteMessage.groupJid);
            
            return results.attrs.from;
        }),
        groupGetInviteInfo: async (code) => {
            const results = await groupQuery('@g.us', 'get', [{ tag: 'invite', attrs: { code } }]);
            const metadata = (0, exports.extractGroupMetadata)(results);
            
            // تخزين معلومات الدعوة في الكاش
            groupCache.set(metadata.id, metadata);
            
            return metadata;
        },
        groupToggleEphemeral: async (jid, ephemeralExpiration) => {
            const content = ephemeralExpiration ?
                { tag: 'ephemeral', attrs: { expiration: ephemeralExpiration.toString() } } :
                { tag: 'not_ephemeral', attrs: {} };
            await groupQuery(jid, 'set', [content]);
            
            // تحديث الكاش بعد تغيير الإعدادات
            await updateGroupCache(jid);
        },
        groupSettingUpdate: async (jid, setting) => {
            await groupQuery(jid, 'set', [{ tag: setting, attrs: {} }]);
            
            // تحديث الكاش بعد تغيير الإعدادات
            await updateGroupCache(jid);
        },
        groupMemberAddMode: async (jid, mode) => {
            await groupQuery(jid, 'set', [{ tag: 'member_add_mode', attrs: {}, content: mode }]);
            
            // تحديث الكاش بعد تغيير وضع الإضافة
            await updateGroupCache(jid);
        },
        groupJoinApprovalMode: async (jid, mode) => {
            await groupQuery(jid, 'set', [{ tag: 'membership_approval_mode', attrs: {}, content: [{ tag: 'group_join', attrs: { state: mode } }] }]);
            
            // تحديث الكاش بعد تغيير وضع الموافقة
            await updateGroupCache(jid);
        },
        groupFetchAllParticipating,
        // إضافة دوال إضافية لإدارة الكاش
        getGroupCache: () => groupCache,
        hasGroupInCache: (jid) => groupCache.has(jid),
        getCachedGroup: (jid) => groupCache.get(jid),
        setCachedGroup: (jid, metadata) => groupCache.set(jid, metadata),
        deleteCachedGroup: (jid) => groupCache.del(jid)
    };
};

exports.makeGroupsSocket = makeGroupsSocket;

const extractGroupMetadata = (result) => {
    var _a, _b;
    const group = (0, WABinary_1.getBinaryNodeChild)(result, 'group');
    const descChild = (0, WABinary_1.getBinaryNodeChild)(group, 'description');
    let desc;
    let descId;
    let descOwner;
    let descOwnerLid;
    let descTime;
    
    if (descChild) {
        desc = (0, WABinary_1.getBinaryNodeChildString)(descChild, 'body');
        descOwner = (0, WABinary_1.jidNormalizedUser)(descChild.attrs.participant_pn || descChild.attrs.participant);
        if (group.attrs.addressing_mode === 'lid') {
            descOwnerLid = (0, WABinary_1.jidNormalizedUser)(descChild.attrs.participant);
        }
        descId = descChild.attrs.id;
        descTime = descChild.attrs.t ? +descChild.attrs.t : undefined;
    }
    
    const groupSize = group.attrs.size ? Number(group.attrs.size) : undefined;
    const groupId = group.attrs.id.includes('@') ? group.attrs.id : (0, WABinary_1.jidEncode)(group.attrs.id, 'g.us');
    const eph = (_a = (0, WABinary_1.getBinaryNodeChild)(group, 'ephemeral')) === null || _a === void 0 ? void 0 : _a.attrs.expiration;
    const memberAddMode = (0, WABinary_1.getBinaryNodeChildString)(group, 'member_add_mode') === 'all_member_add';
    
    const metadata = {
        id: groupId,
        addressingMode: group.attrs.addressing_mode,
        subject: group.attrs.subject,
        subjectOwner: (0, WABinary_1.jidNormalizedUser)(group.attrs.s_o_pn || group.attrs.s_o),
        ...(group.attrs.addressing_mode === 'lid' ? { subjectOwnerLid: (0, WABinary_1.jidNormalizedUser)(group.attrs.s_o) } : {}),
        subjectTime: group.attrs.s_t ? +group.attrs.s_t : undefined,
        size: groupSize || (0, WABinary_1.getBinaryNodeChildren)(group, 'participant').length,
        creation: group.attrs.creation ? +group.attrs.creation : undefined,
        owner: (0, WABinary_1.jidNormalizedUser)(group.attrs.creator_pn || group.attrs.creator),
        ...(group.attrs.addressing_mode === 'lid' ? { ownerLid: (0, WABinary_1.jidNormalizedUser)(group.attrs.creator) } : {}),
        desc,
        descId,
        descOwner,
        descOwnerLid,
        descTime,
        linkedParent: ((_b = (0, WABinary_1.getBinaryNodeChild)(group, 'linked_parent')) === null || _b === void 0 ? void 0 : _b.attrs.jid) || undefined,
        restrict: !!(0, WABinary_1.getBinaryNodeChild)(group, 'locked'),
        announce: !!(0, WABinary_1.getBinaryNodeChild)(group, 'announcement'),
        isCommunity: !!(0, WABinary_1.getBinaryNodeChild)(group, 'parent'),
        isCommunityAnnounce: !!(0, WABinary_1.getBinaryNodeChild)(group, 'default_sub_group'),
        joinApprovalMode: !!(0, WABinary_1.getBinaryNodeChild)(group, 'membership_approval_mode'),
        memberAddMode,
        participants: (0, WABinary_1.getBinaryNodeChildren)(group, 'participant').map(({ attrs }) => {
            return {
                id: attrs.jid,
                jid: attrs.phone_number || attrs.jid,
                lid: attrs.lid || attrs.jid,
                admin: (attrs.type || null),
            };
        }),
        ephemeralDuration: eph ? +eph : undefined
    };
    
    return metadata;
};

exports.extractGroupMetadata = extractGroupMetadata;
