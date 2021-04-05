import * as debug_ from "debug";
import * as xmldom from "xmldom";

import { IStreamAndLength, IZip } from "@r2-utils-js/_utils/zip/zip";

import { NccTemplate, OpfItemsTemplate, SmilTemplate, TempTemplate } from "@models/daisy2-templates";
import { timeStrToSeconds } from "@models/media-overlay";
import { Publication } from "@models/publication";
import { streamToBufferPromise } from "@r2-utils-js/_utils/stream/BufferUtils";
import { XML } from "@r2-utils-js/_utils/xml-js-mapper";
import { zipHasEntry } from "../_utils/zipHasEntry";
import { NCX } from "./epub/ncx";
import { OPF } from "./epub/opf";

// import { MediaOverlayNode } from "@models/media-overlay";
// import { Metadata } from "@models/metadata";
// import { Properties } from "@models/metadata-properties";
// import { Publication } from "@models/publication";
// import { Link } from "@models/publication-link";
// import { TaJsonDeserialize, TaJsonSerialize } from "@r2-lcp-js/serializable";
import {
    loadFileStrFromZipPath,
} from "./epub-daisy-common";
const debug = debug_("r2:shared#parser/daisy-convert-to-epub");
const headerTags = ["h1", "h2", "h3", "h4", "h5", "h6"];

// function ensureDirs(fspath: string) {
//     const dirname = path.dirname(fspath);

//     if (!fs.existsSync(dirname)) {
//         ensureDirs(dirname);
//         fs.mkdirSync(dirname);
//     }
// }

export const getNccAndNcxFromOpf = async (
    zip: IZip, rootfilePathDecoded: string, rootfilePath: string, publication: Publication): Promise<[OPF, NCX]> => {

    // let timeBegin = process.hrtime();
    const has = await zipHasEntry(zip, rootfilePathDecoded, rootfilePath);
    if (!has) {
        const err = `NOT IN ZIP (container OPF rootfile): ${rootfilePath} --- ${rootfilePathDecoded}`;
        debug(err);
        const zipEntries = await zip.getEntries();
        for (const zipEntry of zipEntries) {
            debug(zipEntry);
        }
        return Promise.reject(err);
    }

    let nccZipStream_: IStreamAndLength;
    try {
        nccZipStream_ = await zip.entryStreamPromise(rootfilePathDecoded);
    } catch (err) {
        debug(err);
        return Promise.reject(err);
    }
    const nccZipStream = nccZipStream_.stream;

    // const timeElapsed1 = process.hrtime(timeBegin);
    // debug(`1) ${timeElapsed1[0]} seconds + ${timeElapsed1[1]} nanoseconds`);
    // timeBegin = process.hrtime();

    let nccZipData: Buffer;
    try {
        nccZipData = await streamToBufferPromise(nccZipStream);
    } catch (err) {
        debug(err);
        return Promise.reject(err);
    }

    // debug(`${nccZipData.length} bytes`);

    // const timeElapsed2 = process.hrtime(timeBegin);
    // debug(`2) ${timeElapsed2[0]} seconds + ${timeElapsed2[1]} nanoseconds`);
    // timeBegin = process.hrtime();

    const nccStr = nccZipData.toString("utf8");

    let [opfStr, ncxStr] = await convertDaisyToOPFAndNCX(nccStr, zip);

    if (!opfStr || !ncxStr) {
        return Promise.reject("Opf or Ncx conversion error");
    }
    publication.Daisy2Files = [
        {
            data: opfStr,
            name: "package.opf",
        }, {
            data: ncxStr,
            name: "navigation.ncx",
        }];

    let iStart = opfStr.indexOf("<package");
    if (iStart >= 0) {
        const iEnd = opfStr.indexOf(">", iStart);
        if (iEnd > iStart) {
            const clip = opfStr.substr(iStart, iEnd - iStart);
            if (clip.indexOf("xmlns") < 0) {
                opfStr = opfStr.replace(/<package/, "<package xmlns=\"http://openebook.org/namespaces/oeb-package/1.0/\" ");
            }
        }
    }

    // const timeElapsed3 = process.hrtime(timeBegin);
    // debug(`3) ${timeElapsed3[0]} seconds + ${timeElapsed3[1]} nanoseconds`);
    // timeBegin = process.hrtime();

    // TODO: this takes some time with large OPF XML data
    // (typically: many manifest items),
    // but it remains acceptable.
    // e.g. BasicTechnicalMathWithCalculus.epub with 2.5MB OPF!
    const opfDoc = new xmldom.DOMParser().parseFromString(opfStr);

    // const timeElapsed4 = process.hrtime(timeBegin);
    // debug(`4) ${timeElapsed4[0]} seconds + ${timeElapsed4[1]} nanoseconds`);
    // const timeBegin = process.hrtime();

    // tslint:disable-next-line:no-string-literal
    // process.env["OPF_PARSE"] = "true";
    // TODO: this takes a MASSIVE amount of time with large OPF XML data
    // (typically: many manifest items)
    // e.g. BasicTechnicalMathWithCalculus.epub with 2.5MB OPF!
    // culprit: XPath lib ... so we use our own mini XPath parser/matcher
    // (=> performance gain in orders of magnitude!)
    const opf = XML.deserialize<OPF>(opfDoc, OPF);
    // tslint:disable-next-line:no-string-literal
    // process.env["OPF_PARSE"] = "false";

    // const timeElapsed5 = process.hrtime(timeBegin);
    // debug(`5) ${timeElapsed5[0]} seconds + ${timeElapsed5[1]} nanoseconds`);

    opf.ZipPath = rootfilePathDecoded;

    // breakLength: 100  maxArrayLength: undefined
    // debug(util.inspect(opf,
    //     { showHidden: false, depth: 1000, colors: true, customInspect: true }));

    // ============================== NCX ============================

    iStart = ncxStr.indexOf("<ncx");
    if (iStart >= 0) {
        const iEnd = ncxStr.indexOf(">", iStart);
        if (iEnd > iStart) {
            const clip = ncxStr.substr(iStart, iEnd - iStart);
            if (clip.indexOf("xmlns") < 0) {
                ncxStr = ncxStr.replace(/<ncx/, "<ncx xmlns=\"http://www.daisy.org/z3986/2005/ncx/\" ");
            }
        }
    }

    const ncxDoc = new xmldom.DOMParser().parseFromString(ncxStr);
    const ncx = XML.deserialize<NCX>(ncxDoc, NCX);
    ncx.ZipPath = rootfilePathDecoded;

    // breakLength: 100  maxArrayLength: undefined
    // debug(util.inspect(ncx,
    //     { showHidden: false, depth: 1000, colors: true, customInspect: true }));

    return [opf, ncx];
};

export const convertDaisyToOPFAndNCX = async (
    nccStr: string, zip: IZip,
): Promise<[string | undefined, string | undefined]> => {
    return new Promise(async (resolve, reject) => {
        const entries = await zip.getEntries();

        try {

            // const htmlContent = await loadFileStrFromZipPath(
            //     smilPathInZip,
            //     smilPathInZip,
            //     zip
            // );

            if (!nccStr) {
                debug("!loadFileStrFromZipPath", nccStr);
                return undefined;
            }

            const parsedHtml = new xmldom.DOMParser().parseFromString(
                nccStr,
                "text/html",
            );

            const bodyData = parsedHtml.getElementsByTagName("body")[0];

            const nccObj: NccTemplate = {
                meta: getMetas(parsedHtml),
                nccItems: await convertNavData(bodyData, zip),
            };

            const opfItems: OpfItemsTemplate = {
                manifest: [],
                spine: [],
            };

            convertOpfJson(opfItems, entries);

            let multimediaContent = "";
            let multimediaType = "";
            // "audioFullText","textNCX","audioNCX";
            if (timeStrToSeconds(nccObj.meta["ncc:totalTime"]) > 0) {
                multimediaContent = "audio,text,image";
                multimediaType = "audioFullText";
            } else if (
                timeStrToSeconds(nccObj.meta["ncc:totalTime"]) === 0
            ) {
                multimediaContent = "text,image";
                multimediaType = "textNCX";
            }

            const navPointPartial = convertListToTemplate(
                nccObj.nccItems.filter((file: any) => headerTags.includes(file.tag)), // only header tags
            );
            const pageListPartial = covertToPageList(
                nccObj.nccItems.filter((file: any) => !headerTags.includes(file.tag)), // non header tags
            );

            const manifestPartial = convertListToManifest(opfItems.manifest);

            const spinePartial = convertListToSpine(opfItems.spine);

            const opfTemplate = `<?xml version="1.0" encoding="UTF-8"?>
                <!DOCTYPE package
                    PUBLIC "+//ISBN 0-9673008-1-9//DTD OEB 1.2 Package//EN"
                    "http://openebook.org/dtds/oeb-1.2/oebpkg12.dtd">
                <package xmlns="http://openebook.org/namespaces/oeb-package/1.0/" unique-identifier="uid">
                        <metadata>
                            <dc-metadata xmlns:dc="http://purl.org/dc/elements/1.1/"
                                    xmlns:oebpackage="http://openebook.org/namespaces/oeb-package/1.0/">
                                <dc:Format>ANSI/NISO Z39.86-2005</dc:Format>
                            <dc:Date>${nccObj.meta["dc:date"]}</dc:Date>
                        <dc:Language>${nccObj.meta["dc:language"]}</dc:Language>
                        <dc:Creator>${nccObj.meta["dc:creator"]}</dc:Creator>
                        <dc:Publisher>${nccObj.meta["dc:publisher"]}</dc:Publisher>
                        <dc:Title>${nccObj.meta["dc:title"]}</dc:Title>
                        <dc:Identifier id="uid">${nccObj.meta["dc:identifier"]}</dc:Identifier>
                        </dc-metadata>

                            <x-metadata>
                        <meta content="${multimediaType}" name="dtb:multimediaType"/>
                        <meta content="${nccObj.meta["ncc:narrator"]}" name="dtb:narrator"/>
                        <meta content="${nccObj.meta["ncc:totalTime"]}" name="dtb:totalTime"/>
                        <meta content="${multimediaContent}" name="dtb:multimediaContent"/>
                        </x-metadata>

                        </metadata>
                    <manifest>
                    <item href="package.opf" id="opf" media-type="text/xml" />
                    <item href="navigation.ncx" id="ncx" media-type="application/x-dtbncx+xml" />
                    ${manifestPartial}
                    </manifest>

                        <spine>
                        <itemref idref="smil-1"/>
                        ${spinePartial}
                    </spine>

                </package>`;

            const ncxTemplate = `<?xml version="1.0" encoding="UTF-8"?>
                <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
                <head>
                    <meta name="dtb:uid" content="${nccObj.meta["dc:identifier"]}" />
                    <meta name="dtb:generator" content="${nccObj.meta["ncc:generator"]}"/>
                    <meta name="dtb:depth" content="${nccObj.meta["ncc:depth"]}"/>
                    <meta name="dtb:totalPageCount" content="${nccObj.meta["ncc:pageNormal"]}"/>
                    <meta name="dtb:maxPageNumber" content="${nccObj.meta["ncc:maxPageNormal"]}"/>
                </head>
                <docTitle>
                    <text>${nccObj.meta["dc:title"]}</text>
                </docTitle>
                <docAuthor>
                    <text>${nccObj.meta["dc:creator"]}</text>
                </docAuthor>
                <navMap id="navMap">
                    ${navPointPartial}
                </navMap>
                <pageList id="page">
                    ${pageListPartial}
                </pageList>
                </ncx>`;

            return resolve([opfTemplate, ncxTemplate]);
        } catch (erreur) {
            debug(erreur);
        } finally {
                reject("YAZL zip took too long!? ");
        }
    });
};

/* =========== METHODS ===========*/

const convertListToTemplate = (navPoints: any[]) => {
    let template = "";
    const navDataList = [];
    // const h1Tags = navPoints.filter(point => point.tag === 'h1');
    const tempObj: any = {}; // to store last tag map
    for (const navPoint of navPoints) {
        if (navPoint.tag === "h1") {
            const temp = { ...navPoint, children: [] };
            tempObj.h1 = temp;
            navDataList.push(temp);
        }
        if (navPoint.tag === "h2") {
            const temp = { ...navPoint, children: [] };
            tempObj.h2 = temp;
            tempObj.h1.children.push(temp);
        }
        if (navPoint.tag === "h3") {
            const temp = { ...navPoint, children: [] };
            tempObj.h3 = temp;
            tempObj.h2.children.push(temp);
        }
        if (navPoint.tag === "h4") {
            const temp = { ...navPoint, children: [] };
            tempObj.h4 = temp;
            tempObj.h3.children.push(temp);
        }
        if (navPoint.tag === "h5") {
            const temp = { ...navPoint, children: [] };
            tempObj.h5 = temp;
            tempObj.h4.children.push(temp);
        }
        if (navPoint.tag === "h6") {
            const temp = { ...navPoint, children: [] };
            tempObj.h6 = temp;
            tempObj.h5.children.push(temp);
        }
    }
    for (const navPoint of navDataList) {
        template += convertPointToTemplate(navPoint);
    }

    return template;
};

const convertPointToTemplate = (navPoint: any) => {
    let childNavPoint = "";
    if (navPoint.children && navPoint.children.length > 0) {
        for (const point of navPoint.children) {
            childNavPoint += convertPointToTemplate(point);
        }
    }
    const currentTagNum = navPoint.tag.split("")[1];
    return `<navPoint id="navPoint-${
        navPoint.playOrder
    }" playOrder="${
        navPoint.playOrder
    }" class="level-${currentTagNum}">
        <navLabel>
            <text>${navPoint.text}</text>
                ${
                    navPoint.smilData.audioEl
                        ? `<audio id="${navPoint.smilData.audioEl.id}"
                        src="${navPoint.smilData.audioEl.src}"
                        clipBegin="${navPoint.smilData.audioEl.clipBegin}"
                        clipEnd="${navPoint.smilData.audioEl.clipEnd}" />`
                        : ""
                }
        </navLabel>
        <content src="${navPoint.smilData.parSrc}"/>
        ${childNavPoint}
        </navPoint>
        `;
};

const covertToPageList = (pageList: any[]) => {
    let template = "";
    // for (let i = 0; i < pageList.length; i++) {
    for (const page of pageList) {
        template += convertPointToPageTarget(page);
    }

    return template;
};

const convertPointToPageTarget = (pageItem: any) => {
    return `<pageTarget id="pageTarget-${
        pageItem.playOrder
    }" playOrder="${pageItem.playOrder}" type="normal">
        <navLabel>
            <text>${pageItem.text}</text>
            ${
                pageItem.smilData.audioEl
                    ? `<audio id="${pageItem.smilData.audioEl.id}"
                    src="${pageItem.smilData.audioEl.src}"
                    clipBegin="${pageItem.smilData.audioEl.clipBegin}"
                    clipEnd="${pageItem.smilData.audioEl.clipEnd}" />`
                    : ""
            }
        </navLabel>
        <content src="${pageItem.smilData.parSrc}" />
    </pageTarget>
    `;
};

const convertListToManifest = (manifestList: any[]) => {
    let template = "";
    // for (let i = 0; i < manifestList.length; i++) {
    for (const manifest of manifestList) {
        template += `<item href="${manifest.href}"
        id="${manifest.id}"
        media-type="${manifest.mediaType}" />`;
    }

    return template;
};

const convertListToSpine = (spineList: any[]) => {
    let template = "";
    // for (let i = 0; i < spineList.length; i++) {
    for (const spine of spineList) {
        template += `  <itemref idref="${spine.idref}" />`;
    }

    return template;
};
/* ======== CONVERT NCC TO JSON ======= */

const getMetas = (parsedHtml: any) => {
    const metaObj: any = {};
    const metas = parsedHtml.getElementsByTagName("meta");

    // tslint:disable-next-line: prefer-for-of
    for (let i = 0; i < metas.length; i++) {
        metaObj[metas[i].getAttribute("name")] = metas[i].getAttribute("content");
    }

    return metaObj;
};

const getSrcSmilData = async (anchor: any, zip: IZip) => {
    const hrefAttr = anchor.getAttribute("href");
    const [link, elId] = hrefAttr.split("#");
    const smilStr = await loadFileStrFromZipPath(link, link, zip);
    if (!smilStr) {
        debug("!loadFileStrFromZipPath", smilStr);
        return null;
    }
    const parsedSmil = new xmldom.DOMParser().parseFromString(smilStr, "application/xml");
    // const parsedSmil = parser.parseFromString(
    //     smilFileTxt,
    //     "text/html"
    // );
    let smilEl = parsedSmil.getElementById(elId);
    const smilObj: SmilTemplate = {
        audioEl: "",
        parSrc: "",
    };
    if (!smilEl) {
        return null;
    }
    if (smilEl.tagName !== "par") {
        smilEl = findParentParTag(smilEl);
        if (!smilEl) {
            return null;
        }
        const parId = smilEl.getAttribute("id");
        smilObj.parSrc = link + "#" + parId;
    } else {
        smilObj.parSrc = anchor.getAttribute("href");
    }

    const seq = smilEl.getElementsByTagName("seq")[0];
    if (seq) {
        const audios = smilEl.getElementsByTagName("audio");
        if (audios && audios.length > 0) {
            // smilObj.audioEl = serializer.serializeToString(audioInsidePar);
            let clipBegin = "";
            let clipEnd = "";
            let id = "";
            let src = "";
            for (let i = 0; i < audios.length; i++) {
                if (i === 0) {
                    clipBegin = audios[i].getAttribute("clip-begin") || "";
                    src = audios[i].getAttribute("src") || "";
                    id = audios[i].getAttribute("id") || "";
                }
                if (i === audios.length - 1) {
                    clipEnd = audios[i].getAttribute("clip-end") || "";
                }
            }

            smilObj.audioEl = {
                clipBegin: clipBegin.replace("npt=", ""),
                clipEnd: clipEnd.replace("npt=", ""),
                id,
                src,
            };
        }
    }
    // const audioInsidePar = smilEl.getElementsByTagName("audio")[0];
    // if (audioInsidePar) {
    //     // smilObj.audioEl = serializer.serializeToString(audioInsidePar);
    //     const clipBegin =  audioInsidePar.getAttribute("clip-begin");
    //     const clipEnd = audioInsidePar.getAttribute("clip-end");

    //     smilObj.audioEl = {
    //         clipBegin: clipBegin ? clipBegin.replace("npt=", "") : "",
    //         clipEnd: clipEnd ? clipEnd.replace("npt=", "") : "",
    //         id: audioInsidePar.getAttribute("id"),
    //         src: audioInsidePar.getAttribute("src"),
    //     };
    // }

    return smilObj;
};

const findParentParTag = (tag: any): any => {
    if (tag.tagName === "par") {
        return tag;
    }
    return findParentParTag(tag.parentNode);
};

const getNextTag = (tag: any): any => {
    if (!tag.nextSibling) {
        return null;
    }

    if (tag.nextSibling.tagName) {
        return tag.nextSibling;
    }

    return getNextTag(tag.nextSibling);
};

const convertToJs = async (tag: any, navPoints: any[], playOrder: any, zip: IZip) => {
    playOrder++;
    const anchor = tag.getElementsByTagName("a")[0];
    const smilData = await getSrcSmilData(anchor, zip);
    const tempObj: TempTemplate = {
        playOrder,
        smilData,
        tag: tag.tagName,
        text: anchor.textContent,
    };

    navPoints.push(tempObj);
    const nextTag = getNextTag(tag);

    if (nextTag) {
        await convertToJs(nextTag, navPoints, playOrder, zip);
    }
};

const convertNavData = async (bodyData: any, zip: IZip) => {
    const navPoints: any[] = [];
    const playOrder = 0;

    const firstH1Tag = bodyData.getElementsByTagName("h1")[0];
    await convertToJs(firstH1Tag, navPoints, playOrder, zip);
    navPoints.sort((a, b) => {
        // a less than b
        if (a.playOrder < b.playOrder) {
            return -1;
        }
        // a more than b
        if (a.playOrder > b.playOrder) {
            return 1;
        }
        // a === b
        return 0;
    });

    return navPoints;
};

const convertOpfJson = (opfItems: any, files: string[]) => {
    // const re = /(?:\.([^.]+))?$/;  // find extension
    // let regex = new RegExp('[^.]+$');
    files.forEach((file, i) => {
        // const ext = re.exec(file)[1];
        // const ext = file.match(regex);
        const ext = file.split(".").pop() || "";
        if (["ent", "dtd"].includes(ext)) {
            return;
        }
        if (ext === "smil") {
            opfItems.manifest.push({
                href: file,
                id: "smil-" + i,
                mediaType: getMediaType(ext),
            });

            opfItems.spine.push({
                idref: "smil-" + i,
            });
        } else {
            opfItems.manifest.push({
                href: file,
                id: "opf-" + i,
                mediaType: getMediaType(ext),
            });
        }
    });
};

const getMediaType = (ext: string) => {
    if (ext === "smil") {
        return "application/smil";
    }

    if (ext === "css") {
        return "text/css";
    }

    if (ext === "mp3") {
        return "audio/mpeg";
    }

    if (ext === "jpg") {
        return "image/jpeg";
    }

    if (ext === "png") {
        return "image/png";
    }

    if (ext === "xml") {
        return "application/x-dtbook+xml";
    }

    if (ext === "html") {
        return "text/html";
    }

    return "";
};
