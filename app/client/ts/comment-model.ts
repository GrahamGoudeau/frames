

import { DataIDHandle, SerializedDataID, AppendableDataHandle, Drop,
         StructuredDataHandle, withDropP, AppedableDataMetadata,
         TYPE_TAG_VERSIONED, StructuredDataMetadata
       } from "safe-launcher-client";

import * as crypto from "crypto";

import { safeClient, NoUserNameError } from "./util";
const sc = safeClient;

import * as uuidV4 from "uuid/v4";

import Config from "./global-config";
const CONFIG = Config.getInstance();

export default class VideoComment implements Drop {

    public readonly owner: string;
    public readonly text: string;

    // A 53 bit integer (thanks javascript!) representing the number of
    // seconds since unix epoch at the last edit.
    public readonly date: Date;

    // The structured data version of the parent at the time of
    // the last edit. Including this info will make it easier for
    // users to tell when a comment does not make sense because the
    // parent edited it.
    public readonly parentVersion: number;

    // true if this is a direct reply to a video
    public readonly isRootComment: boolean;

    // a pointer to a video if `this.isRootComment`, otherwise
    // a pointer to a comment
    public readonly parent: DataIDHandle;

    public readonly replies: AppendableDataHandle;

    //
    // Private members
    //

    private readonly replyMetadata: Promise<AppedableDataMetadata>;
    private commentData: StructuredDataHandle;
    private metadata: Promise<StructuredDataMetadata>;

    private constructor(owner: string, text: string, date: Date,
                parentVersion: number, isRootComment: boolean,
                parent: DataIDHandle, replies: AppendableDataHandle) {
        this.owner = owner;
        this.text = text;
        this.date = date;
        this.parentVersion = parentVersion;
        this.isRootComment = isRootComment;
        this.parent = parent;
        this.replies = replies;

        this.replyMetadata = this.replies.getMetadata();
        this.commentData = null;
        this.metadata = null;
    }
    public async drop(): Promise<void> {
        await this.parent.drop();
        await this.replies.drop();
    }
    private setCommentData(cd: StructuredDataHandle): void {
        this.commentData = cd;
        this.metadata = cd.getMetadata();
    }
    public xorName(): Promise<DataIDHandle> {
        return this.commentData.toDataIdHandle();
    }

    public static async new(owner: string, text: string, date: Date,
                            parentVersion: number, isRootComment: boolean,
                            parent: DataIDHandle): Promise<VideoComment> {
        const replies: AppendableDataHandle = await sc.ad.create(uuidV4());
        await replies.save();
        const vc = new VideoComment(owner, text, date, parentVersion, isRootComment,
                                    parent, replies);
        vc.setCommentData(await vc.write());
        return vc;
    }

    public static async read(did: DataIDHandle): Promise<VideoComment> {
        const sdH: StructuredDataHandle =
            (await sc.structured.fromDataIdHandle(did)).handleId;

        const content: any = await sdH.readAsObject();
        if (!isCommentInfoStringy(content))
            throw new Error("Malformed comment info");

        const ci: CommentInfo = toCI(content);

        const parent: DataIDHandle = await sc.dataID.deserialise(ci.parent);

        const replies: AppendableDataHandle =
            (await withDropP(await sc.dataID.deserialise(ci.replies), (r) => {
                return sc.ad.fromDataIdHandle(r);
            })).handleId;

        const vc = new VideoComment(ci.owner, ci.text, ci.date, ci.parentVersion,
                                ci.isRootComment, parent, replies);
        vc.setCommentData(sdH);
        return vc;
    }

    public async addComment(text: string): Promise<VideoComment> {
        const owner: string =
            CONFIG.getLongName().caseOf({
                just: n => n,
                nothing: () => {throw new NoUserNameError("You need to select a username.");}
            });

        const comment = await VideoComment.new(
            owner,
            text,
            new Date(),
            (await this.metadata).version,
            false,
            await this.commentData.toDataIdHandle());

        await withDropP(await comment.xorName(), n => this.replies.append(n));
        return comment;
    }

    // TODO(ethan): test to make sure that this method is idempotent
    private async write(): Promise<StructuredDataHandle> {
        const payload: CommentInfo = {
            owner: this.owner,
            text: this.text,
            date: this.date,
            isRootComment: this.isRootComment,
            parentVersion: this.parentVersion,
            parent: await this.parent.serialise(),
            replies: await withDropP(await this.replies.toDataIdHandle(), (r) => {
                return r.serialise();
            })
        };
        const payloadStr: string = JSON.stringify(toCIStringy(payload));

        const hash: string = crypto.createHash("sha256")
            .update(payloadStr)
            .digest("hex");

        const sd = await sc.structured.create(hash, TYPE_TAG_VERSIONED, payloadStr);
        await sd.save();
        return sd;
    }

    public async getNumReplies(): Promise<number> {
        return (await this.replyMetadata).dataLength;
    }

    public async getReply(i: number): Promise<VideoComment> {
        if (i >= await this.getNumReplies() || i < 0)
            throw new Error(`VideoComment::getReply(${i}) index out of range!`);

        return withDropP(await this.replies.at(i), (di) => {
            return VideoComment.read(di);
        });
    }

}


//
// The stuff we actually store on the network. Boilerplate.
//

interface CommentInfoBase {
    owner: string;
    text: string;
    date: Date;
    isRootComment: boolean;
    parentVersion: number;
}
function isCommentInfoBase(x: any): x is CommentInfoBase {
    return  ( typeof x.owner === "string"
              && typeof x.text === "string"
              && typeof x.date === "string"
              && typeof x.isRootComment === "boolean"
              && typeof x.parentVersion === "number");
}
interface CommentInfoStringy extends CommentInfoBase {
    parent: string; // base64 encoded
    replies: string; // base64 encoded
}
function isCommentInfoStringy(x: any): x is CommentInfoStringy {
    return (typeof x.parent === "string"
            && typeof x.replies === "string"
            && isCommentInfoBase(x));
}
function toCI(x: CommentInfoStringy): CommentInfo {
    return {
        owner: x.owner,
        text: x.text,
        date: new Date(x.date),
        isRootComment: x.isRootComment,
        parentVersion: x.parentVersion,
        parent: Buffer.from(x.parent, "base64"),
        replies: Buffer.from(x.replies, "base64")
    }
}
interface CommentInfo extends CommentInfoBase {
    parent: Buffer; // base64 encoded
    replies: Buffer; // base64 encoded
}
function toCIStringy(x: CommentInfo): CommentInfoStringy {
    return {
        owner: x.owner,
        text: x.text,
        date: x.date,
        isRootComment: x.isRootComment,
        parentVersion: x.parentVersion,
        parent: x.parent.toString("base64"),
        replies: x.replies.toString("base64")
    }
}
