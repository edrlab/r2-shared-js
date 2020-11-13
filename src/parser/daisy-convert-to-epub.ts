// ==LICENSE-BEGIN==
// Copyright 2017 European Digital Reading Lab. All rights reserved.
// Licensed to the Readium Foundation under one or more contributor license agreements.
// Use of this source code is governed by a BSD-style license
// that can be found in the LICENSE file exposed on Github (readium) in the project repository.
// ==LICENSE-END==

import * as debug_ from "debug";
import * as fs from "fs";
import * as path from "path";
import * as xmldom from "xmldom";
import * as xpath from "xpath";

import { Publication } from "@models/publication";
import { Link } from "@models/publication-link";
import { TaJsonDeserialize, TaJsonSerialize } from "@r2-lcp-js/serializable";
import { IZip } from "@r2-utils-js/_utils/zip/zip";

import { loadFileStrFromZipPath } from "./epub-daisy-common";

// import * as moment from "moment";

// import { timeStrToSeconds } from "@models/media-overlay";
// import { Metadata } from "@models/metadata";
// import { Link } from "@models/publication-link";
// import { isHTTP } from "@r2-utils-js/_utils/http/UrlUtils";
// import { XML } from "@r2-utils-js/_utils/xml-js-mapper";
// import { zipLoadPromise } from "@r2-utils-js/_utils/zip/zipFactory";

// import { zipHasEntry } from "../_utils/zipHasEntry";
// import { Rootfile } from "./epub/container-rootfile";
// import { NCX } from "./epub/ncx";
// import { NavPoint } from "./epub/ncx-navpoint";
// import { OPF } from "./epub/opf";
// import { Manifest } from "./epub/opf-manifest";
// import { SpineItem } from "./epub/opf-spineitem";
// import { SMIL } from "./epub/smil";
// import { Par } from "./epub/smil-par";
// import { Seq } from "./epub/smil-seq";

const debug = debug_("r2:shared#parser/daisy-convert-to-epub");

// interface ParsedFile {
//     Name: string;
//     Type: string;
//     Value: string;
//     FilePath: string;
// }

function ensureDirs(fspath: string) {
    const dirname = path.dirname(fspath);

    if (!fs.existsSync(dirname)) {
        ensureDirs(dirname);
        fs.mkdirSync(dirname);
    }
}

export const convertDaisyToEpub = async (outputDirPath: string, publication: Publication) => {

    const zipInternal = publication.findFromInternal("zip");
    if (!zipInternal) {
        debug("No publication zip!?");
        return;
    }
    const zip = zipInternal.Value as IZip;

    const resources = [...publication.Resources]; // reference copy, which is fine
    for (const resLink of resources) {
        // relative to publication root (package.opf / ReadiumWebPubManifest.json)
        if (!resLink.HrefDecoded) {
            continue;
        }
        if (resLink.TypeLink === "text/css" || resLink.HrefDecoded.endsWith(".css")) {
            debug("CSS", resLink.HrefDecoded);

            let cssText = await loadFileStrFromZipPath(resLink.Href, resLink.HrefDecoded, zip);
            if (!cssText) {
                debug("!loadFileStrFromZipPath", resLink.HrefDecoded);
                continue;
            }
            // debug(cssText);

            // replace comments
            cssText = cssText.replace(/\/\*([\s\S]+?)\*\//gm, (_match, p1, _offset, _string) => {
                const base64 = Buffer.from(p1).toString("base64");
                return `/*__${base64}__*/`;
            });

            const elementNames = [
                "address",
                "annoref",
                "annotation",
                "author",
                "bdo",
                "bodymatter",
                "book",
                "bridgehead",
                "byline",
                "caption",
                "cite",
                "col",
                "colgroup",
                "covertitle",
                "dateline",
                "dfn",
                "docauthor",
                "doctitle",
                "dtbook",
                "epigraph",
                "frontmatter",
                "hd",
                "imggroup",
                "kbd",
                "level",
                "levelhd",
                "level1",
                "level2",
                "level3",
                "level4",
                "level5",
                "level6",
                "lic",
                "line",
                "linegroup",
                "linenum",
                "link",
                "list",
                "meta",
                "note",
                "noteref",
                "pagenum",
                "poem",
                "prodnote",
                "rearmatter",
                "samp",
                "sent",
                "sub",
                "sup",
                "br",
                "q",
                "w",
                "notice",
                "sidebar",
                "blockquote",
                "abbr",
                "acronym",
                "title",
            ];
            // const regex = new RegExp(`[^#\.](${elementNames.join("|")})`, "g");
            for (const elementName of elementNames) {
                // debug("A ############");
                // debug(elementName);
                // debug("B ############");
                // allows comma, whitespace, colon prefix/suffix chars, which are used in CSS selectors
                const regex = new RegExp(
                    `([^#\.a-zA-Z0-9\-_\(\);<>\*~\+])(${elementName})([^a-zA-Z0-9\-_\(\);<>\*~\+])`, "g");
                // let i = -1;
                // let match: RegExpExecArray | null;
                // // tslint:disable-next-line: no-conditional-assignment
                // while (match = regex.exec(cssText)) {
                //     i++;
                //     debug("A -----------");
                //     debug(i, elementName, `$_$_$${match[0]}$_$_$`, `===${match[1]}^^^${match[2]}^^^${match[3]}===`);
                //     debug("B -----------");
                // }
                cssText = cssText.replace(regex, `$1.$2_R2$3`);
                cssText = cssText.replace(regex, `$1.$2_R2$3`); // second pass
                // debug("C ############");
            }

            // restore comments
            cssText = cssText.replace(/\/\*__([\s\S]+?)__\*\//g, (_match, p1, _offset, _string) => {
                const comment = Buffer.from(p1, "base64").toString("utf8");
                return `/*${comment}*/`;
            });

            const newCssFilePath = resLink.HrefDecoded.replace(/\.css$/, "__.css");
            // debug(cssText);
            const cssOutputFilePath = path.join(outputDirPath, newCssFilePath);
            ensureDirs(cssOutputFilePath);
            fs.writeFileSync(cssOutputFilePath, cssText);

            const resLinkJson = TaJsonSerialize(resLink);
            // resLinkJson.href = newCssFilePath;
            const resLinkClone = TaJsonDeserialize<Link>(resLinkJson, Link);
            resLinkClone.setHrefDecoded(newCssFilePath);
            publication.Resources.push(resLinkClone);

        } else if (resLink.TypeLink === "application/x-dtbook+xml" || resLink.HrefDecoded.endsWith(".xml")) {

            const dtBookStr = await loadFileStrFromZipPath(resLink.Href, resLink.HrefDecoded, zip);
            if (!dtBookStr) {
                debug("!loadFileStrFromZipPath", dtBookStr);
                continue;
            }
            const dtBookDoc = new xmldom.DOMParser().parseFromString(dtBookStr, "application/xml");

            const title = dtBookDoc.getElementsByTagName("doctitle")[0].textContent;
            debug(resLink.HrefDecoded, title);

            const listElements = dtBookDoc.getElementsByTagName("list");
            for (let i = 0; i < listElements.length; i++) {
                const listElement = listElements.item(i);
                if (!listElement) {
                    continue;
                }
                const type = listElement.getAttribute("type");
                if (type) {
                    const oldElementName = listElement.tagName;
                    // read-only property!
                    (listElement as any).tagName = type;
                    debug(i, oldElementName, listElement.tagName, type);
                }
            }

            // <dtbook xmlns="http://www.daisy.org/z3986/2005/dtbook/" ...
            const select = xpath.useNamespaces({
                dtbook: "http://www.daisy.org/z3986/2005/dtbook/",
                // epub: "http://www.idpf.org/2007/ops",
                // xhtml: "http://www.w3.org/1999/xhtml",
            });

            // <?xml-stylesheet type="text/css" href="dtbookbasic.css"?>
            const stylesheets =
                select("/processing-instruction('xml-stylesheet')", dtBookDoc) as ProcessingInstruction[];
            const cssHrefs: string[] = []; // `<link rel="stylesheet" href="${cssHref}" />`
            let index = -1;
            for (const stylesheet of stylesheets) {
                if (!stylesheet.nodeValue) {
                    continue;
                }
                if (!stylesheet.nodeValue.includes("text/css")) {
                    continue;
                }
                const match = stylesheet.nodeValue.match(/href=("|')(.*?)("|')/);
                if (!match) {
                    continue;
                }
                index++;
                const href = match[2].trim();
                if (href) {
                    debug(index, href);
                    cssHrefs.push(href);
                }
            }
        }

        // // const newFilePath = path.join(urlOrPath, newFileName);
        // // if (fs.existsSync(filePath) && !fs.existsSync(newFilePath)) {
        // // let cssText = fs.readFileSync(filePath, { encoding: "utf8" });

        // const cssPath = path.join(path.dirname(opf.ZipPath), src)
        //     .replace(/\\/g, "/");
        // let cssText = await loadFileStrFromZipPath(cssPath, cssPath, zip);
        // if (!cssText) {
        //     debug("!loadFileStrFromZipPath", cssPath);
        //     continue;
        // }
        // cssText = transformCss(cssText);

        // const parsedFile: ParsedFile = {
        //     FilePath: path.join(path.dirname(opf.ZipPath), newFileName)
        //         .replace(/\\/g, "/"),
        //     Name: newFileName,
        //     Type: "text/css",
        //     Value: cssText.trim(),
        // };
        // parsedFiles.push(parsedFile);

        // // fs.writeFileSync(newFilePath , cssText.trim());
        // // debug("CSS File Saved!");
        // const tempManifest = new Manifest();
        // tempManifest.ID = `dtb_css${index + 1}`;
        // tempManifest.setHrefDecoded(newFileName);
        // tempManifest.MediaType = parsedFile.Type;
        // opf.Manifest.push(tempManifest);

        // links.push(`<link rel="stylesheet" href="${newFileName}" />`);
        // index++;

        // const parsedFiles: ParsedFile[] = [];

        // // note: does not work in RemoteExploded
        // const entries = await zip.getEntries();

        // // "application/x-dtbook+xml" content type
        // // manifest/item@media-type
        // const dtBookZipEntryPath = entries.find((entry) => entry.match(/\.xml$/));
        // if (dtBookZipEntryPath) {
        //     const dtBookStr = await loadFileStrFromZipPath(dtBookZipEntryPath, dtBookZipEntryPath, zip);
        //     if (!dtBookStr) {
        //         debug("!loadFileStrFromZipPath", dtBookStr);
        //     } else {
        //         // debug("loadFileStrFromZipPath: ", dtBookStr);
        //         // const dtBookDoc = new xmldom.DOMParser().parseFromString(dtBookStr, "application/xml");
        //         // parsedFiles = await convertXml(dtBookDoc, zip, opf);
        //     }
        // }

        // debug("parsedFiles", parsedFiles.map((parsedFile) => {
        //     return {
        //         FilePath: parsedFile.FilePath,
        //         Name: parsedFile.Name,
        //         Type: parsedFile.Type,
        //     };
        // }));

        // parsedFiles.forEach((file) => {
        //     fs.writeFileSync(path.join(outputDirPath, file.FilePath), file.Value);
        // });
    }
};

// const convertXml = async (xmlDom: Document, zip: IZip, opf: OPF): Promise<ParsedFile[]> => {
//     if (!opf.ZipPath) {
//         return Promise.reject("!opf.ZipPath??");
//     }

//     const parsedFiles: ParsedFile[] = [];

//     const title = xmlDom.getElementsByTagName("doctitle")[0].textContent;

//     transformListElements(xmlDom);

//     const select = xpath.useNamespaces({
//         // epub: "http://www.idpf.org/2007/ops",
//         // xhtml: "http://www.w3.org/1999/xhtml",
//     });

//     const stylesheets = select("/processing-instruction('xml-stylesheet')", xmlDom) as ProcessingInstruction[];
//     const links: string[] = [];
//     let index = 0;
//     for (const stylesheet of stylesheets) {
//         if (!stylesheet.nodeValue) {
//             continue;
//         }
//         const match = stylesheet.nodeValue.match(/href=("|')(.*?)("|')/);
//         if (!match) {
//             continue;
//         }
//         const href = match[0];
//         if (href) {
//             const src = href.split("=")[1].replace(/"/g, "");
//             // const filePath = path.join(urlOrPath, src);
//             const newFileName = `style_${index}.css`;
//             // const newFilePath = path.join(urlOrPath, newFileName);
//             // if (fs.existsSync(filePath) && !fs.existsSync(newFilePath)) {
//             // let cssText = fs.readFileSync(filePath, { encoding: "utf8" });

//             const cssPath = path.join(path.dirname(opf.ZipPath), src)
//                 .replace(/\\/g, "/");
//             let cssText = await loadFileStrFromZipPath(cssPath, cssPath, zip);
//             if (!cssText) {
//                 debug("!loadFileStrFromZipPath", cssPath);
//                 continue;
//             }
//             cssText = transformCss(cssText);

//             const parsedFile: ParsedFile = {
//                 FilePath: path.join(path.dirname(opf.ZipPath), newFileName)
//                     .replace(/\\/g, "/"),
//                 Name: newFileName,
//                 Type: "text/css",
//                 Value: cssText.trim(),
//             };
//             parsedFiles.push(parsedFile);

//             // fs.writeFileSync(newFilePath , cssText.trim());
//             // debug("CSS File Saved!");
//             const tempManifest = new Manifest();
//             tempManifest.ID = `dtb_css${index + 1}`;
//             tempManifest.setHrefDecoded(newFileName);
//             tempManifest.MediaType = parsedFile.Type;
//             opf.Manifest.push(tempManifest);

//             links.push(`<link rel="stylesheet" href="${newFileName}" />`);
//             index++;
//         }
//     }

//     opf.Spine.Items = [];

//     const serializer = new xmldom.XMLSerializer();
//     const data: string[] = [];
//     parseFrontmatterXml(xmlDom, serializer, data);
//     parseBodymatterXml(xmlDom, serializer, data);
//     parseRearmatterXml(xmlDom, serializer, data);

//     let i = 0;
//     for (const element of data) {
//         const content = element
//             .replace('xmlns="', 'xmlns:conf="')
//             .replace(/<frontmatter/g, '<div class="frontmatter"')
//             .replace(/<bodymatter/g, '<div class="bodymatter"')
//             .replace(/<rearmatter/g, '<div class="rearmatter">')
//             .replace(/<\/frontmatter>/g, "</div>")
//             .replace(/<\/bodymatter>/g, "</div>")
//             .replace(/<\/rearmatter>/g, "</div>")
//             .replace(/<level(\d)>/g, '<div class="level level-$1">')
//             .replace(/<\/level\d>/g, "</div>")
//             .replace(/<doctitle/g, "<h1 class='doctitle'")
//             .replace(/<\/doctitle>/g, "</h1>")
//             .replace(/<docauthor/g, "<p class='docauthor'")
//             .replace(/<\/docauthor>/g, "</p>")
//             .replace(/<covertitle/g, "<p class='covertitle'")
//             .replace(/<\/covertitle>/g, "</p>")
//             .replace(/<pagenum/g, "<span class='pagenum'")
//             .replace(/<\/pagenum>/g, "</span>")
//             .replace(/<sent/g, "<span")
//             .replace(/<\/sent>/g, "</span>")
//             .replace(/(<\/?)imggroup/g, "$1figure")
//             .replace(/<caption/g, "<figcaption")
//             .replace(/<\/caption>/g, "</figcaption>");

//         const xhtmlContent = `
//             <?xml version="1.0" encoding="utf-8"?>
//             <!DOCTYPE xhtml>
//             <html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
//             <head>
//                 <meta charset="UTF-8" />
//                 <title>${title}</title>
//                 ${links.join(" ")}
//             </head>
//             <body>
//                 <div class="book">
//                     ${content}
//                 </div>
//             </body>
//             </html>
//         `;
//         const pageName = `page${i + 1}.xhtml`;
//         const tempManifest = new Manifest();
//         tempManifest.ID = `dtb_page${i + 1}`;
//         tempManifest.setHrefDecoded(pageName);
//         tempManifest.MediaType = "application/xhtml+xml";
//         opf.Manifest.push(tempManifest);

//         const tempSpineItem = new SpineItem();
//         tempSpineItem.IDref = tempManifest.ID;
//         opf.Spine.Items.push(tempSpineItem);

//         const parsedFile: ParsedFile = {
//             FilePath: path.join(path.dirname(opf.ZipPath), pageName)
//                 .replace(/\\/g, "/"),
//             Name: pageName,
//             Type: "application/xhtml+xml",
//             Value: xhtmlContent.trim(),
//         };
//         parsedFiles.push(parsedFile);

//         const xhtmlDoc = new xmldom.DOMParser().parseFromString(xhtmlContent, "text/html");
//         const smilRefs = select("//@smilref", xhtmlDoc) as Attr[];
//         const refs = smilRefs.map((smilRef) => {
//             return smilRef.value.split("#")[0]; // get link only
//         });
//         // const smilRefLinks = [...new Set(refs)]; // remove duplicate
//         const multimediaContent = opf.Metadata.XMetadata.Meta.find((metaTag) => {
//             return metaTag.Name === "dtb:multimediaContent";
//         });
//         if (!multimediaContent || !multimediaContent.Content.includes("audio")) {
//             i++;
//             continue;
//         }

//         if (process.env) {
//             throw new Error("AUDIO SMIL");
//         }

//         const smilRefLinks = refs.filter((ref: string, ind: number) => {
//             return refs.indexOf(ref) === ind;
//         }); // remove duplicate

//         let duration = 0;
//         for (const smilRefLink of smilRefLinks) {
//             const smil = await parseSmilFile(zip, smilRefLink, opf);
//             if (!smil) {
//                 continue;
//             }
//             // setMediaInfo(tempManifest, tempSpineItem, file);
//             duration += getMediaDuration(smil);
//         }

//         // hacky way to temporarily store item duration,
//         // but much simpler than storing into "media:duration" OPF MetaData with #refines (ala EPUB)
//         tempManifest.MediaOverlay = duration.toString();

//         i++;
//     }

//     return parsedFiles;
// };

// const getMediaDuration = (smilFile: SMIL): number => {

//     if (smilFile?.Body?.Children) {
//         const firstChild = smilFile.Body.Children[0];
//         if (firstChild) {
//             // Duck typing ...
//             if ((firstChild as Seq).Children ||
//                 !(firstChild as Par).Text && !(firstChild as Par).Audio &&
//                 (firstChild as Seq).Duration) {

//                 return timeStrToSeconds((firstChild as Seq).Duration);
//             }
//         }
//     }

//     return 0;
// };

// const parseFrontmatterXml = (xmlDom: Document, serializer: xmldom.XMLSerializer, data: string[]) => {
//     let levelDoms = [];
//     const frontmatter = xmlDom.getElementsByTagName("frontmatter")[0];
//     if (frontmatter) {
//         const docTitle = frontmatter.getElementsByTagName("doctitle")[0];
//         const docAuthor = frontmatter.getElementsByTagName("docauthor")[0];
//         const coverTitle = frontmatter.getElementsByTagName("covertitle")[0];
//         const level1s = Array.from(frontmatter.getElementsByTagName("level1"));
//         const levels = Array.from(frontmatter.getElementsByTagName("level"));

//         levelDoms = levels.concat(level1s);
//         if (levelDoms.length > 0) {
//             levelDoms.forEach((element: Element, i: number) => {
//                 if (!element.parentNode) {
//                     return;
//                 }
//                 const bodyContent = element.parentNode.cloneNode();
//                 if (i === 0) {
//                     if (docTitle) {
//                         bodyContent.appendChild(docTitle);
//                     }
//                     if (docAuthor) {
//                         bodyContent.appendChild(docAuthor);
//                     }
//                     if (coverTitle) {
//                         bodyContent.appendChild(coverTitle);
//                     }
//                 }
//                 bodyContent.appendChild(element);
//                 const bodyContentStr = serializer.serializeToString(bodyContent);
//                 data.push(bodyContentStr);
//             });
//         } else {
//             const bodyContent = frontmatter.cloneNode();
//             if (docTitle) {
//                 bodyContent.appendChild(docTitle);
//             }
//             if (docAuthor) {
//                 bodyContent.appendChild(docAuthor);
//             }
//             if (coverTitle) {
//                 bodyContent.appendChild(coverTitle);
//             }
//             const bodyContentStr = serializer.serializeToString(bodyContent);
//             data.push(bodyContentStr);
//         }
//     }
// };

// const parseBodymatterXml = (xmlDom: Document, serializer: xmldom.XMLSerializer, data: string[]) => {
//     let levelDoms = [];
//     const bodymatter = xmlDom.getElementsByTagName("bodymatter")[0];
//     if (bodymatter) {
//         const level1s = Array.from(bodymatter.getElementsByTagName("level1"));
//         const levels = Array.from(bodymatter.getElementsByTagName("level"));

//         levelDoms = levels.concat(level1s);
//         levelDoms.forEach((element) => {
//             if (!element.parentNode) {
//                 return;
//             }
//             const bodyContent = element.parentNode.cloneNode();
//             bodyContent.appendChild(element);
//             const bodyContentStr = serializer.serializeToString(bodyContent);
//             data.push(bodyContentStr);
//         });
//     }
// };

// const parseRearmatterXml = (xmlDom: Document, serializer: xmldom.XMLSerializer, data: string[]) => {
//     let levelDoms = [];
//     const rearmatter = xmlDom.getElementsByTagName("rearmatter")[0];
//     if (rearmatter) {
//         const level1s = Array.from(rearmatter.getElementsByTagName("level1"));
//         const levels = Array.from(rearmatter.getElementsByTagName("level"));

//         levelDoms = levels.concat(level1s);
//         levelDoms.forEach((element) => {
//             if (!element.parentNode) {
//                 return;
//             }
//             const bodyContent = element.parentNode.cloneNode();
//             bodyContent.appendChild(element);
//             const bodyContentStr = serializer.serializeToString(bodyContent);
//             data.push(bodyContentStr);
//         });
//     }
// };

// const parseSmilFile = async (zip: IZip, srcDecoded: string, opf: OPF): Promise<SMIL> => {
//     if (!opf.ZipPath) {
//         return Promise.reject("!opf.ZipPath??");
//     }
//     const smilPath = path.join(path.dirname(opf.ZipPath), srcDecoded)
//         .replace(/\\/g, "/");
//     debug(`>>>>> parseSmilFile ${smilPath}`);
//     const smilStr = await loadFileStrFromZipPath(smilPath, smilPath, zip);
//     if (!smilStr) {
//         return Promise.reject("!loadFileStrFromZipPath: " + smilPath);
//     }
//     const smilXmlDoc = new xmldom.DOMParser().parseFromString(smilStr);
//     return XML.deserialize<SMIL>(smilXmlDoc, SMIL);
// };

// const getSmilLinkReference = async (
//     parsedFiles: ParsedFile[], zip: IZip, srcDecoded: string, opf: OPF): Promise<string | undefined> => {

//     const hashLink = srcDecoded.split("#");
//     const smilLink = hashLink[0];
//     const smilID = hashLink[1];

//     // const smilFilePath = path.join(filePath, smilLink).replace(/\\/g, "/");

//     // const smilStr = fs.readFileSync(smilFilePath, { encoding: "utf8" });
//     const smil = await parseSmilFile(zip, smilLink, opf);

//     const linkedPar = findParInSmilWithID(smil, smilID);
//     if (!linkedPar) {
//         return undefined;
//     }
//     if (linkedPar.Text) {
//         const hashXmlLink = linkedPar.Text.Src.split("#");
//         const xmlID = hashXmlLink[1];
//         const xmlLink = findXhtmlWithID(parsedFiles, xmlID);
//         return `${xmlLink}#${xmlID}`;
//         // return linkedPar.Text.Src;
//     }

//     return undefined;
// };

// const findXhtmlWithID = (parsedFiles: ParsedFile[], ID: string) => {
//     for (const parsedFile of parsedFiles) {
//         // const parsedFile: ParsedFile = publication.ParsedFiles[i];
//         if (parsedFile.Type === "application/xhtml+xml") {
//             const xhtmlDoc = new xmldom.DOMParser().parseFromString(parsedFile.Value, "text/html");
//             if (xhtmlDoc.getElementById(ID)) {
//                 return parsedFile.Name;
//             }
//         }
//     }
//     return;
//     // publication.ParsedFiles.forEach((parsedFile: ParsedFile, i: number) => {
//     //     if (parsedFile.Type === "application/xhtml+xml") {
//     //         const xhtmlDoc = new xmldom.DOMParser().parseFromString(parsedFile.Value, "text/html");
//     //         if (xhtmlDoc.getElementById(ID)) {
//     //             debug("xhtmlDoc" + i, parsedFile.Name);
//     //         }
//     //     }
//     // });
// };

// const findParInSeqWithID = (seq: Seq, id: string): Par | undefined => {
//     for (const child of seq.Children) {
//         // Duck typing ...
//         if ((child as Seq).Children) {
//             const found = findParInSeqWithID(child as Seq, id);
//             if (found) {
//                 return found;
//             }
//             continue;
//         }
//         const par = child as Par;
//         if ((par.Text || par.Audio) &&
//             par.ID === id) {

//             return par;
//         }
//     }
//     return undefined;
// };
// const findParInSmilWithID = (smil: SMIL, id: string): Par | undefined => {
//     if (smil.Body) {
//         return findParInSeqWithID(smil.Body, id);
//     }
//     return undefined;
// };