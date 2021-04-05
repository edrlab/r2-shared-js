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
import { ZipFile } from "yazl";

import { MediaOverlayNode } from "@models/media-overlay";
import { Metadata } from "@models/metadata";
import { Properties } from "@models/metadata-properties";
import { Publication } from "@models/publication";
import { Link } from "@models/publication-link";
import { TaJsonDeserialize, TaJsonSerialize } from "@r2-lcp-js/serializable";
import { IZip } from "@r2-utils-js/_utils/zip/zip";

import {
    lazyLoadMediaOverlays, loadFileBufferFromZipPath, loadFileStrFromZipPath, updateDurations,
} from "./epub-daisy-common";

const debug = debug_("r2:shared#parser/daisy-convert-to-epub");

function ensureDirs(fspath: string) {
    const dirname = path.dirname(fspath);

    if (!fs.existsSync(dirname)) {
        ensureDirs(dirname);
        fs.mkdirSync(dirname);
    }
}

// this function modifies the input parameter "publication"!
export const convertDaisyToReadiumWebPub = async (
    outputDirPath: string, publication: Publication): Promise<string | undefined> => {

    return new Promise(async (resolve, reject) => {

        // dtb:multimediaContent ==> audio,text
        const isFullTextAudio = publication.Metadata?.AdditionalJSON &&
            publication.Metadata.AdditionalJSON["dtb:multimediaType"] === "audioFullText";

        // dtb:multimediaContent ==> audio
        const isAudioOnly = publication.Metadata?.AdditionalJSON &&
            publication.Metadata.AdditionalJSON["dtb:multimediaType"] === "audioNCX";

        // dtb:multimediaContent ==> text
        const isTextOnly = publication.Metadata?.AdditionalJSON &&
            publication.Metadata.AdditionalJSON["dtb:multimediaType"] === "textNCX";

        const zipInternal = publication.findFromInternal("zip");
        if (!zipInternal) {
            debug("No publication zip!?");
            return reject("No publication zip!?");
        }
        const zip = zipInternal.Value as IZip;

        const outputZipPath = path.join(outputDirPath, `${isAudioOnly ? "daisy_audioNCX" : (isTextOnly ? "daisy_textNCX" : "daisy_audioFullText")}-to-epub.webpub`);
        ensureDirs(outputZipPath);

        let timeoutId: NodeJS.Timeout | undefined;
        const zipfile = new ZipFile();
        try {
            const writeStream = fs.createWriteStream(outputZipPath);
            zipfile.outputStream.pipe(writeStream)
                .on("close", () => {
                    debug("ZIP close");
                    if (timeoutId) {
                        clearTimeout(timeoutId);
                        timeoutId = undefined;
                        resolve(outputZipPath);
                    }
                })
                .on("error", (e: any) => {
                    debug("ZIP error", e);
                    reject(e);
                });

            // <dtbook xmlns="http://www.daisy.org/z3986/2005/dtbook/" ...
            const select = xpath.useNamespaces({
                dtbook: "http://www.daisy.org/z3986/2005/dtbook/",
                // epub: "http://www.idpf.org/2007/ops",
                // xhtml: "http://www.w3.org/1999/xhtml",
            });

            // http://www.daisy.org/z3986/structure/SG-DAISY3/index-of-elements.html
            // a
            // abbr
            // acronym
            // address
            // annoref
            // annotation
            // author
            // bdo
            // blockquote
            // bodymatter
            // book
            // br
            // bridgehead
            // byline
            // caption
            // cite
            // code
            // col
            // colgroup
            // covertitle
            // dateline
            // dd
            // dfn
            // div
            // dl
            // docauthor
            // doctitle
            // dt
            // dtbook
            // em
            // epigraph
            // frontmatter
            // h1
            // h2
            // h3
            // h4
            // h5
            // h6
            // hd
            // head
            // img
            // imggroup
            // kbd
            // level
            // level1
            // level2
            // level3
            // level4
            // level5
            // level6
            // li
            // lic
            // line
            // linegroup
            // linenum
            // link
            // list
            // meta
            // note
            // noteref
            // p
            // pagenum
            // poem
            // prodnote
            // q
            // rearmatter
            // samp
            // sent
            // sidebar
            // span
            // strong
            // sub
            // sup
            // table
            // tbody
            // td
            // tfoot
            // th
            // thead
            // title
            // tr
            // w

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
                "q",
                "w",
                "notice",
                "sidebar",
                "blockquote",
                "abbr",
                "acronym",
                "title",
            ];

            interface TmoMap {
                [smilTextRef: string]: {
                    index: number,
                    mos: MediaOverlayNode[],
                };
            }
            let mediaOverlaysMap: TmoMap | undefined;

            const getMediaOverlaysDuration = (mo: MediaOverlayNode): number => {
                let duration: number = 0;

                if (typeof mo.AudioClipBegin !== "undefined" &&
                    typeof mo.AudioClipEnd !== "undefined") {

                    duration = mo.AudioClipEnd - mo.AudioClipBegin;

                } else if (mo.Children) {
                    for (const child of mo.Children) {
                        duration += getMediaOverlaysDuration(child);
                    }
                }

                return duration;
            };

            const patchMediaOverlaysTextHref = (
                mo: MediaOverlayNode,
                audioOnlySmilHtmlHref: string | undefined): string | undefined => {

                let smilTextRef: string | undefined;

                if (audioOnlySmilHtmlHref && !mo.Text && mo.Audio) {
                    smilTextRef = audioOnlySmilHtmlHref;
                    mo.Text = `${smilTextRef}#${mo.ParID || "_yyy_"}`;
                } else if (mo.Text) {
                    // TODO: .xml file extension replacement is bit weak / brittle
                    // (but for most DAISY books, this is a reasonable expectation)
                    mo.Text = mo.Text.replace(/\.xml/, ".xhtml");
                    smilTextRef = mo.Text;
                    const k = smilTextRef.indexOf("#");
                    if (k > 0) {
                        smilTextRef = smilTextRef.substr(0, k);
                    }
                }
                if (mo.Children) {
                    for (const child of mo.Children) {
                        const smilTextRef_ = patchMediaOverlaysTextHref(child, audioOnlySmilHtmlHref);
                        if (!smilTextRef_) {
                            debug("########## WARNING: !smilTextRef ???!!", smilTextRef_, child);
                        } else if (smilTextRef && smilTextRef !== smilTextRef_) {
                            debug("########## WARNING: smilTextRef !== smilTextRef_ ???!!", smilTextRef, smilTextRef_);
                        }
                        if (!smilTextRef) {
                            smilTextRef = smilTextRef_;
                        }
                    }
                }

                return smilTextRef;
            };

            // in-memory cache for expensive SMIL XML DOM parsing
            const smilDocs: Record<string, Document> = {};

            const findLinkInToc = (links: Link[], hrefDecoded: string): Link | undefined => {
                for (const link of links) {
                    if (link.HrefDecoded === hrefDecoded) {
                        return link;
                    } else if (link.Children) {
                        const foundLink = findLinkInToc(link.Children, hrefDecoded);
                        if (foundLink) {
                            return foundLink;
                        }
                    }
                }
                return undefined;
            };

            const createHtmlFromSmilFile = async (smilPathInZip: string): Promise<string | undefined> => {

                let smilDoc = smilDocs[smilPathInZip];
                if (!smilDoc) {
                    const smilStr = await loadFileStrFromZipPath(smilPathInZip, smilPathInZip, zip);
                    if (!smilStr) {
                        debug("!loadFileStrFromZipPath", smilStr);
                        return undefined;
                    }
                    smilDoc = new xmldom.DOMParser().parseFromString(smilStr, "application/xml");
                    smilDocs[smilPathInZip] = smilDoc;
                }

                // getElementsByName(elementName: string): NodeListOf<HTMLElement>
                // ==> not available in the XMLDOM API
                // getElementsByTagName(qualifiedName: string): HTMLCollectionOf<Element>
                const parEls = Array.from(smilDoc.getElementsByTagName("par"));
                for (const parEl of parEls) {

                    // getElementsByName(elementName: string): NodeListOf<HTMLElement>
                    // ==> not available in the XMLDOM API
                    // getElementsByTagName(qualifiedName: string): HTMLCollectionOf<Element>
                    const audioElements = Array.from(parEl.getElementsByTagName("audio")).filter((el) => el);
                    for (const audioElement of audioElements) {
                        if (audioElement.parentNode) {
                            audioElement.parentNode.removeChild(audioElement);
                        }
                    }

                    const elmId = parEl.getAttribute("id");
                    const hrefDecoded = `${smilPathInZip}#${elmId}`;
                    const tocLinkItem = findLinkInToc(publication.TOC, hrefDecoded);
                    const text = tocLinkItem ? tocLinkItem.Title : undefined;

                    const textNode = smilDoc.createTextNode(text ? text : ".");
                    parEl.appendChild(textNode);
                }

                const bodyContent = smilDoc.getElementsByTagName("body")[0];
                const bodyContentStr = new xmldom.XMLSerializer().serializeToString(bodyContent);
                const contentStr = bodyContentStr
                    .replace(`xmlns="http://www.w3.org/2001/SMIL20/"`, "")
                    .replace(/dur=/g, "data-dur=")
                    .replace(/fill=/g, "data-fill=")
                    .replace(/customTest=/g, "data-customTest=")
                    .replace(/class=/g, "data-class=")
                    .replace(/<seq/g, '<div class="smil-seq"')
                    .replace(/<par/g, '<p class="smil-par"')
                    .replace(/<\/seq>/g, "</div>")
                    .replace(/<\/par>/g, "</p>")
                    ;

                const htmlDoc = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
    <head>
        <title>${smilPathInZip}</title>
    </head>
    ${contentStr}
</html>
`;
                const htmlFilePath = smilPathInZip.replace(/\.smil$/, ".xhtml");
                // const fileName = path.parse(href).name;
                zipfile.addBuffer(Buffer.from(htmlDoc), htmlFilePath);
                return htmlFilePath;
            };

            const audioOnlySmilHtmls: Link[] = [];

            if (publication.Daisy2Files && publication.Daisy2Files.length > 0) {
                for (const file of publication.Daisy2Files) {
                    zipfile.addBuffer(Buffer.from(file.data), file.name);
                }
            }

            if (publication.Spine) {

                mediaOverlaysMap = {};

                let previousLinkItem: Link | undefined;
                let spineIndex = -1;
                for (const linkItem of publication.Spine) {
                    spineIndex++;
                    if (!linkItem.MediaOverlays) {
                        continue;
                    }

                    if (!linkItem.MediaOverlays.initialized) {
                        // mo.initialized true/false is automatically handled
                        await lazyLoadMediaOverlays(publication, linkItem.MediaOverlays);

                        if (isFullTextAudio || isAudioOnly) {
                            updateDurations(linkItem.MediaOverlays.duration, linkItem);
                        }
                    }

                    if (isFullTextAudio || isAudioOnly) {
                        const computedDur = getMediaOverlaysDuration(linkItem.MediaOverlays);
                        if (computedDur) {
                            if (!linkItem.MediaOverlays.duration) {
                                linkItem.MediaOverlays.duration = computedDur;

                                updateDurations(computedDur, linkItem);
                            } else {
                                if (Math.round(linkItem.MediaOverlays.duration) !== Math.round(computedDur)) {
                                    debug("linkItem.MediaOverlays.duration !== computedDur",
                                        linkItem.MediaOverlays.duration, computedDur);
                                }
                            }
                        }

                        if (previousLinkItem && previousLinkItem.MediaOverlays &&
                            // !previousLinkItem.MediaOverlays.duration &&
                            typeof previousLinkItem.MediaOverlays.totalElapsedTime !== "undefined" &&
                            typeof linkItem.MediaOverlays.totalElapsedTime !== "undefined") {

                            const dur = linkItem.MediaOverlays.totalElapsedTime -
                                previousLinkItem.MediaOverlays.totalElapsedTime;
                            if (dur > 0) {
                                if (!previousLinkItem.MediaOverlays.duration) {
                                    previousLinkItem.MediaOverlays.duration = dur;

                                    updateDurations(dur, previousLinkItem);
                                } else {
                                    if (Math.round(previousLinkItem.MediaOverlays.duration) !== Math.round(dur)) {
                                        debug("previousLinkItem.MediaOverlays.duration !== dur",
                                            previousLinkItem.MediaOverlays.duration, dur);
                                    }
                                }
                            }
                        }
                        previousLinkItem = linkItem;
                    }

                    let smilTextRef: string | undefined;

                    if (isAudioOnly) {
                        const audioOnlySmilHtmlHref =
                            linkItem.MediaOverlays.SmilPathInZip?.replace(/\.smil$/, ".xhtml");
                        if (audioOnlySmilHtmlHref) {
                            smilTextRef = patchMediaOverlaysTextHref(linkItem.MediaOverlays, audioOnlySmilHtmlHref);
                        }
                    } else {
                        smilTextRef = patchMediaOverlaysTextHref(linkItem.MediaOverlays, undefined);
                    }

                    if (smilTextRef) {
                        if (isAudioOnly && linkItem.MediaOverlays.SmilPathInZip) {
                            await createHtmlFromSmilFile(linkItem.MediaOverlays.SmilPathInZip);

                            const smilHtml = new Link();
                            smilHtml.Href = smilTextRef;
                            smilHtml.TypeLink = "application/xhtml+xml";
                            audioOnlySmilHtmls.push(smilHtml);
                        }

                        // spineIndex++;
                        if (!mediaOverlaysMap[smilTextRef]) {
                            mediaOverlaysMap[smilTextRef] = {
                                index: spineIndex,
                                mos: [],
                            };
                        }
                        // captures the last index in the reading order
                        mediaOverlaysMap[smilTextRef].index = spineIndex;
                        mediaOverlaysMap[smilTextRef].mos.push(linkItem.MediaOverlays);
                    }
                }
            }
            publication.Spine = [];

            const resourcesToKeep: Link[] = [];

            const dtBooks: Link[] = [...audioOnlySmilHtmls];
            // reference copy! (not by value) so we can publication.Resources.push(...) safely within the loop
            // const resources = [...publication.Resources];
            // ... but we completely replace the array of Links, so this is fine:
            for (const resLink of publication.Resources) {
                // relative to publication root (package.opf / ReadiumWebPubManifest.json)
                if (!resLink.HrefDecoded) {
                    continue;
                }
                if (resLink.TypeLink === "text/css" || resLink.HrefDecoded.endsWith(".css")) {

                    let cssText = await loadFileStrFromZipPath(resLink.Href, resLink.HrefDecoded, zip);
                    if (!cssText) {
                        debug("!loadFileStrFromZipPath", resLink.HrefDecoded);
                        continue;
                    }

                    // replace comments
                    cssText = cssText.replace(/\/\*([\s\S]+?)\*\//gm, (_match, p1, _offset, _string) => {
                        const base64 = Buffer.from(p1).toString("base64");
                        return `/*__${base64}__*/`;
                    });

                    // const regex = new RegExp(`[^#\.](${elementNames.join("|")})`, "g");
                    for (const elementName of elementNames) {
                        // meant to patch CSS selectors, but not property values
                        const regex = new RegExp(
                            `([^#\.a-zA-Z0-9\-_])(${elementName})([^a-zA-Z0-9\-_;])`, "g");
                        // let i = -1;
                        // let match: RegExpExecArray | null;
                        // // tslint:disable-next-line: no-conditional-assignment
                        // while (match = regex.exec(cssText)) {
                        //     i++;
                        //     debug("A -----------");
                        //     debug(i, elementName, `$_$_$${match[0]}$_$_$`,
                        // `===${match[1]}^^^${match[2]}^^^${match[3]}===`);
                        //     debug("B -----------");
                        // }
                        cssText = cssText.replace(regex, `$1.$2_R2$3`);

                        // second pass, as the first doesn't match tokens with trailing / leading separators
                        cssText = cssText.replace(regex, `$1.$2_R2$3`);
                    }

                    // restore comments
                    cssText = cssText.replace(/\/\*__([\s\S]+?)__\*\//g, (_match, p1, _offset, _string) => {
                        const comment = Buffer.from(p1, "base64").toString("utf8");
                        return `/*${comment}*/`;
                    });

                    // const newCssFilePath = resLink.HrefDecoded.replace(/\.css$/, "__.css");
                    // const cssOutputFilePath = path.join(outputDirPathExploded, newCssFilePath);
                    // ensureDirs(cssOutputFilePath);
                    // fs.writeFileSync(cssOutputFilePath, cssText);
                    zipfile.addBuffer(Buffer.from(cssText), resLink.HrefDecoded);

                    // const resLinkJson = TaJsonSerialize(resLink);
                    // // resLinkJson.href = newCssFilePath;
                    // const resLinkClone = TaJsonDeserialize<Link>(resLinkJson, Link);
                    // resLinkClone.setHrefDecoded(newCssFilePath);

                    resourcesToKeep.push(resLink);

                } else if (resLink.TypeLink === "application/x-dtbook+xml" || resLink.HrefDecoded.endsWith(".xml")) {

                    // TODO: XSLT?
                    /*
<?xml version="1.0" encoding="UTF-8"?>

<!--******************************
DAISY XSL TRANSFORM

Make an XSL capable browser
understand DAISY markup.
****************************** -->

<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
xmlns:dtb="http://www.daisy.org/z3986/2005/dtbook/">

<xsl:output method="html" indent="no"/>

<!--******************************
DOCBOOK, HEAD, META, LINK, BOOK
*******************************-->

<!-- docbook translates to html -->
<xsl:template match="dtb:dtbook">
<html><xsl:apply-templates/></html>
</xsl:template>

<!-- head maps directly -->
<xsl:template match="dtb:head">
<xsl:element name="head">
<xsl:if test="@profile">
<xsl:attribute name="profile"><xsl:value-of select="@profile"/></xsl:attribute>
</xsl:if>

<title><xsl:value-of select="/dtb:dtbook/dtb:book/dtb:frontmatter/dtb:doctitle"/></title>

<link rel="stylesheet" type="text/css" href="html.css" />

<xsl:apply-templates/>
</xsl:element>
</xsl:template>

<!-- meta maps directly
Include: content
If applicable, include: http-equiv, name
NOTE: meta contains no content so no apply-templates necessary -->
<xsl:template match="dtb:meta">
<xsl:element name="meta">
<xsl:if test="@http-equiv">
<xsl:attribute name="http-equiv"><xsl:value-of select="@http-equiv"/></xsl:attribute>
</xsl:if>
<xsl:if test="@name">
<xsl:attribute name="name"><xsl:value-of select="@name"/></xsl:attribute>
</xsl:if>
<xsl:attribute name="content"><xsl:value-of select="@content"/></xsl:attribute>
</xsl:element>
</xsl:template>

<!-- link maps directly
If aqpplicable, includes: charset, href, hreflang, media, rel, rev, type
NOTE: link contains no content so no apply-templates necessary -->
<xsl:template match="dtb:link">
<xsl:element name="link">
<xsl:call-template name="link-attributes"/>
<xsl:if test="@media">
<xsl:attribute name="media"><xsl:value-of select="@media"/></xsl:attribute>
</xsl:if>
</xsl:element>
</xsl:template>

<!-- book should be translated to body -->
<xsl:template match="dtb:book">
<body>
<xsl:call-template name="segmentedNav"/>
<xsl:apply-templates/>
<xsl:call-template name="segmentedNav"/>
</body>
</xsl:template>

<!-- inter-DTBook navigation -->
<xsl:template name="segmentedNav">
<xsl:if test="/dtb:dtbook/dtb:head/dtb:link[@rel!='']">
<xsl:if test="/dtb:dtbook/dtb:head/dtb:link[@rel='start']">
<xsl:variable name="sn" select="/dtb:dtbook/dtb:head/dtb:link[@rel='start']"/>
<xsl:element name="a">
<xsl:attribute name="href">
<xsl:choose>
<xsl:when test="$sn/@href"><xsl:value-of select="$sn/@href"/></xsl:when>
<xsl:otherwise><xsl:value-of select="$sn/@resource"/></xsl:otherwise>
</xsl:choose>
</xsl:attribute>
<xsl:text>Start</xsl:text>
</xsl:element>
</xsl:if>
<xsl:if test="/dtb:dtbook/dtb:head/dtb:link[@rel='prev']">
<xsl:variable name="pn" select="/dtb:dtbook/dtb:head/dtb:link[@rel='prev']"/>
<xsl:text> | </xsl:text>
<xsl:element name="a">
<xsl:attribute name="href">
<xsl:choose>
<xsl:when test="$pn/@href"><xsl:value-of select="$pn/@href"/></xsl:when>
<xsl:otherwise><xsl:value-of select="$pn/@resource"/></xsl:otherwise>
</xsl:choose>
</xsl:attribute>
<xsl:text>Previous</xsl:text>
</xsl:element>
</xsl:if>
<xsl:if test="/dtb:dtbook/dtb:head/dtb:link[@rel='next']">
<xsl:variable name="nn" select="/dtb:dtbook/dtb:head/dtb:link[@rel='next']"/>
<xsl:text> | </xsl:text>
<xsl:element name="a">
<xsl:attribute name="href">
<xsl:choose>
<xsl:when test="$nn/@href"><xsl:value-of select="$nn/@href"/></xsl:when>
<xsl:otherwise><xsl:value-of select="$nn/@resource"/></xsl:otherwise>
</xsl:choose>
</xsl:attribute>
<xsl:text>Next</xsl:text>
</xsl:element>
</xsl:if>
</xsl:if>
</xsl:template>

<!--*******************************
FRONTMATTER, BODYMATTER, REARMATTER
******************************* -->

<!--frontmatter, bodymatter and rearmatter become divisions with appropriate class attributes-->
<xsl:template match="dtb:frontmatter | dtb:bodymatter | dtb:rearmatter">
<xsl:element name="div">
<xsl:call-template name="base-attributes"/>
<xsl:attribute name="class"><xsl:value-of select="local-name(.)" /></xsl:attribute>
<xsl:apply-templates />
</xsl:element>
</xsl:template>

<!--**************************
DOCTITLE, DOCAUTHOR, COVERTITLE
***************************-->

<!-- doctitle is h1 with class for styling -->
<xsl:template match="dtb:doctitle">
<h1 class="doctitle"><xsl:apply-templates/></h1>
</xsl:template>

<!-- docauthor is p with class for styling -->
<xsl:template match="dtb:docauthor">
<p class="docauthor"><xsl:apply-templates/></p>
</xsl:template>

<!-- covertitle is p with class for styling -->
<xsl:template match="dtb:covertitle">
<p class="covertitle"><xsl:apply-templates/></p>
</xsl:template>

<!--***********************
LEVELS
************************-->

<!-- Levels map to div with class -->
<xsl:template match="dtb:level | dtb:level1 | dtb:level2 | dtb:level3 | dtb:level4 | dtb:level5 | dtb:level6">
<xsl:element name="div">
<xsl:call-template name="base-attributes"/>
<xsl:attribute name="class"><xsl:value-of select="local-name(.)" /></xsl:attribute>
<xsl:apply-templates />
</xsl:element>
</xsl:template>

<!--***********************
HEADINGS
************************-->

<!--h1...h6 map directly -->
<xsl:template match="dtb:h1 | dtb:h2 | dtb:h3 | dtb:h4 | dtb:h5 | dtb:h6">
<xsl:element name="{local-name(.)}">
<xsl:call-template name="base-attributes"/>
<xsl:apply-templates />
</xsl:element>
</xsl:template>

<!-- hd as child of level converts to h1...h6 based on number of level ancestors
If more than 6 ancestors then defaults to h6, flattening hierarchy beyond level 6 -->
<xsl:template match="dtb:level/dtb:hd">
<xsl:variable name="levelDepth" select="count(ancestor-or-self::dtb:level)" />
<xsl:choose>
<xsl:when test="$levelDepth &lt;= 6">
<xsl:element name="{concat('h',$levelDepth)}">
<xsl:call-template name="base-attributes"/>
<xsl:apply-templates/>
</xsl:element>
</xsl:when>
<xsl:otherwise>
<xsl:element name="h6">
<xsl:call-template name="base-attributes"/>
<xsl:apply-templates/>
</xsl:element>
</xsl:otherwise>
</xsl:choose>
</xsl:template>

<!--for hd within items like list use paragraph with class -->
<!-- for bridgehead use paragraph with class -->
<xsl:template match="dtb:hd | dtb:bridgehead">
<xsl:element name="p">
<xsl:call-template name="base-attributes"/>
<xsl:attribute name="class"><xsl:value-of select="local-name(.)" /></xsl:attribute>
<xsl:apply-templates />
</xsl:element>
</xsl:template>

<!--*************************
PAGENUM, LINENUM
************************-->

<!--Put the pagenum into a paragraph element if the parent is level or level1...level6 otherwise put it into a span
Use the pagenum class for formatting -->
<xsl:template match="dtb:pagenum">
<xsl:choose>
<xsl:when test="parent::dtb:level or parent::dtb:level1 or parent::dtb:level2 or
parent::dtb:level3 or parent::dtb:level4 or parent::dtb:level5 or parent::dtb:level6">
<xsl:element name="p">
<xsl:call-template name="base-attributes"/>
<xsl:attribute name="class"><xsl:value-of select="local-name(.)" /></xsl:attribute>
<xsl:apply-templates />
</xsl:element>
</xsl:when>
<xsl:otherwise>
<xsl:element name="span">
<xsl:call-template name="base-attributes"/>
<xsl:attribute name="class"><xsl:value-of select="local-name(.)" /></xsl:attribute>
<xsl:apply-templates />
</xsl:element>
</xsl:otherwise>
</xsl:choose>
</xsl:template>

<!-- linenum is translated to span with class -->
<xsl:template match="dtb:linenum">
<xsl:element name="span">
<xsl:call-template name="base-attributes"/>
<xsl:attribute name="class"><xsl:value-of select="local-name(.)" /></xsl:attribute>
<xsl:apply-templates />
</xsl:element>
</xsl:template>

<!--*************************
GENERAL BLOCKS
************************-->

<!-- address, div, p map directly -->
<xsl:template match="dtb:address | dtb:div | dtb:p">
<xsl:element name="{local-name(.)}">
<xsl:call-template name="base-attributes"/>
<xsl:apply-templates />
</xsl:element>
</xsl:template>

<!-- annotation, epigraph, linegroup, note, poem, prodnote, sidebar map to div with class
For prodnote, sidebar: Exclude: render attribute, no way to express -->
<xsl:template
match="dtb:annotation | dtb:epigraph | dtb:linegroup | dtb:note | dtb:poem | dtb:prodnote | dtb:sidebar">
<xsl:element name="div">
<xsl:call-template name="base-attributes"/>
<xsl:attribute name="class"><xsl:value-of select="local-name(.)" /></xsl:attribute>
<xsl:apply-templates />
</xsl:element>
</xsl:template>

<!-- blockquote maps directly
If applicable, include: cite -->
<xsl:template match="dtb:blockquote">
<xsl:element name="blockquote">
<xsl:call-template name="base-attributes"/>
<xsl:if test="@cite">
<xsl:attribute name="cite"><xsl:value-of select="@cite"/></xsl:attribute>
</xsl:if>

<xsl:apply-templates/>
</xsl:element>
</xsl:template>

<!-- byline, dateline, line maps to a p with class -->
<xsl:template match="dtb:byline | dtb:dateline | dtb:line">
<xsl:element name="p">
<xsl:call-template name="base-attributes"/>
<xsl:attribute name="class"><xsl:value-of select="local-name(.)" /></xsl:attribute>
<xsl:apply-templates />
</xsl:element>
</xsl:template>

<!--*************************
GENERAL INLINES
************************-->

<!-- a maps directly
If applicable, include: charset, href, hreflang, rel, rev, type
If external is true then target a new window -->
<xsl:template match="dtb:a">
<xsl:element name="a">
<xsl:call-template name="base-attributes"/>
<xsl:call-template name="link-attributes"/>
<xsl:if test="@external='true'">
<xsl:attribute name="target">_blank</xsl:attribute>
</xsl:if>

<xsl:apply-templates/>
</xsl:element>
</xsl:template>

<!-- bdo maps directly,
Include: dir -->
<xsl:template match="dtb:bdo">
<bdo dir="{@dir}"><xsl:apply-templates/></bdo>
</xsl:template>

<!-- abbr, acronym, cite, dfn, em, kbd, samp, strong, sub, sup map directly -->
<xsl:template
match="dtb:abbr | dtb:acronym | dtb:cite | dtb:dfn | dtb:em | dtb:kbd | dtb:samp | dtb:strong | dtb:sub | dtb:sup">
<xsl:element name="{local-name(.)}">
<xsl:call-template name="base-attributes"/>
<xsl:apply-templates/>
</xsl:element>
</xsl:template>

<!-- code maps directly
If has class preserve-whitespace then surround with a pre tag -->
<xsl:template match="dtb:code">
<xsl:element name="{local-name(.)}">
<xsl:call-template name="base-attributes"/>
<xsl:choose>
<xsl:when test="@class='preserve-whitespace'">
<xsl:element name="pre"><xsl:apply-templates/></xsl:element>
</xsl:when>
<xsl:otherwise>
<xsl:apply-templates/>
</xsl:otherwise>
</xsl:choose>
</xsl:element>
</xsl:template>

<!-- span maps to span for classes underline, strikethrough,
double-strikethrough, small-caps, but is omitted otherwise -->
<xsl:template match="dtb:span">
<xsl:choose>
<xsl:when test="@class='underline'">
<span class="underline"><xsl:apply-templates/></span>
</xsl:when>
<xsl:when test="@class='strikethrough'">
<span class="strikethrough"><xsl:apply-templates/></span>
</xsl:when>
<xsl:when test="@class='double-strikethrough'">
<span class="double-strikethrough"><xsl:apply-templates/></span>
</xsl:when>
<xsl:when test="@class='small-caps'">
<span class="small-caps"><xsl:apply-templates/></span>
</xsl:when>
<xsl:otherwise>
<xsl:apply-templates/>
</xsl:otherwise>
</xsl:choose>
</xsl:template>

<!--title-->

<!-- author maps to p with class -->
<xsl:template match="dtb:author">
<xsl:element name="p">
<xsl:call-template name="base-attributes"/>
<xsl:attribute name="class"><xsl:value-of select="local-name(.)"/></xsl:attribute>
<xsl:apply-templates/>
</xsl:element>
</xsl:template>

<!-- br maps directly
NOTE: no apply-templates needed since this tag is always self closing-->
<xsl:template match="dtb:br">
<br />
</xsl:template>

<!-- q maps directly
If applicable, includes: cite -->
<xsl:template match="dtb:q">
<xsl:element name="q">
<xsl:call-template name="base-attributes"/>
<xsl:if test="@cite">
<xsl:attribute name="cite"><xsl:value-of select="@cite"/></xsl:attribute>
</xsl:if>

<xsl:apply-templates/>
</xsl:element>
</xsl:template>

<!-- annoref, noteref maps to span with class -->
<xsl:template match="dtb:annoref | dtb:noteref">
<xsl:element name="span">
<xsl:call-template name="base-attributes"/>
<xsl:attribute name="class"><xsl:value-of select="local-name(.)" /></xsl:attribute>
</xsl:element>
</xsl:template>

<!-- sent, w have no equivalent tag -->
<xsl:template match="dtb:sent | dtb:w">
<xsl:apply-templates/>
</xsl:template>

<!--*************************
LISTS
************************-->

<!--Get fancy with the various list types-->

<!-- An unordered list will be wrapped in ul tags -->
<xsl:template match="dtb:list[@type='ul']">
<xsl:element name="ul">
<xsl:call-template name="base-attributes"/>
<xsl:apply-templates/>
</xsl:element>
</xsl:template>

<!-- A preformatted list will be wrapped in ul tags with an appropriate class.
CSS can be used to turn off default display symbols, the list will still be
rendered as such in the browser's DOM, which will let screen readers
announce the item as a list -->
<xsl:template match="dtb:list[@type='pl']">
<xsl:element name="ul">
<xsl:call-template name="base-attributes"/>
<xsl:attribute name="class">pl</xsl:attribute>
<xsl:apply-templates/>
</xsl:element>
</xsl:template>

<!-- An ordered list will be wrapped in ol tags
Ensure the desired formatting is preserved by pushing the enum attribute into the class attribute
Note: replaces enum="1" with class="one" to ensure CSS 2.1 validation
If applicable, include: start -->
<xsl:template match="dtb:list[@type='ol']">
<xsl:element name="ol">
<xsl:call-template name="base-attributes"/>
<xsl:choose>
<xsl:when test="@enum='1'">
<xsl:attribute name="class">one</xsl:attribute>
</xsl:when>
<xsl:otherwise>
<xsl:attribute name="class"><xsl:value-of select="@enum"/></xsl:attribute>
</xsl:otherwise>
</xsl:choose>
<xsl:if test="@start">
<xsl:attribute name="start"><xsl:value-of select="@start"/></xsl:attribute>
</xsl:if>

<xsl:apply-templates/>
</xsl:element>
</xsl:template>

<!-- li maps directly -->
<xsl:template match="dtb:li">
<xsl:element name="li">
<xsl:call-template name="base-attributes"/>
<xsl:apply-templates/>
</xsl:element>
</xsl:template>

<!-- lic maps to span -->
<xsl:template match="dtb:lic">
<xsl:element name="span">
<xsl:call-template name="base-attributes"/>
<xsl:attribute name="class"><xsl:value-of select="local-name(.)"/></xsl:attribute>
<xsl:apply-templates/>
</xsl:element>
</xsl:template>

<!-- *************************
DEFINITION LIST
************************ -->

<!-- dd, dl, dt map directly -->
<xsl:template match="dtb:dd | dtb:dl | dtb:dt">
<xsl:element name="{local-name(.)}">
<xsl:call-template name="base-attributes"/>
<xsl:apply-templates/>
</xsl:element>
</xsl:template>

<!--*************************
TABLES
************************ *** -->

<!-- table maps directly
If applicable, include: border, cellpadding, cellspacing, frame, rules, summary, width -->
<xsl:template match="dtb:table">
<xsl:element name="table">
<xsl:call-template name="base-attributes"/>
<xsl:if test="@border">
<xsl:attribute name="border"><xsl:value-of select="@border"/></xsl:attribute>
</xsl:if>
<xsl:if test="@cellpadding">
<xsl:attribute name="cellpadding"><xsl:value-of select="@cellpadding"/></xsl:attribute>
</xsl:if>
<xsl:if test="@cellspacing">
<xsl:attribute name="cellspacing"><xsl:value-of select="@cellspacing"/></xsl:attribute>
</xsl:if>
<xsl:if test="@frame">
<xsl:attribute name="frame"><xsl:value-of select="@frame"/></xsl:attribute>
</xsl:if>
<xsl:if test="@rules">
<xsl:attribute name="rules"><xsl:value-of select="@rules"/></xsl:attribute>
</xsl:if>
<xsl:if test="@summary">
<xsl:attribute name="summary"><xsl:value-of select="@summary"/></xsl:attribute>
</xsl:if>
<xsl:if test="@width">
<xsl:attribute name="width"><xsl:value-of select="@width"/></xsl:attribute>
</xsl:if>

<xsl:apply-templates/>
</xsl:element>
</xsl:template>

<!-- table/caption maps directly -->
<xsl:template match="dtb:table/dtb:caption">
<xsl:element name="caption">
<xsl:call-template name="base-attributes"/>
<xsl:apply-templates/>
</xsl:element>
</xsl:template>

<!-- tr maps directly
If applicable, include: align, char, charoff, valign -->
<xsl:template match="dtb:tr">
<xsl:element name="tr">
<xsl:call-template name="base-attributes"/>
<xsl:call-template name="alignment-attributes"/>
<xsl:apply-templates/>
</xsl:element>
</xsl:template>

<!-- col, colgroup map directly
If applicable, include: align, char, charoff, span, valign, width -->
<xsl:template match="dtb:col | dtb:colgroup">
<xsl:element name="{local-name(.)}">
<xsl:call-template name="base-attributes"/>
<xsl:call-template name="alignment-attributes"/>
<xsl:if test="@span">
<xsl:attribute name="span"><xsl:value-of select="@span"/></xsl:attribute>
</xsl:if>
<xsl:if test="@width">
<xsl:attribute name="width"><xsl:value-of select="@width"/></xsl:attribute>
</xsl:if>
<xsl:apply-templates/>
</xsl:element>
</xsl:template>

<!-- tbody, thead, tfoot map directly
If applicable, include: align, char, charoff, valign -->
<xsl:template match="dtb:tbody | dtb:thead | dtb:tfoot">
<xsl:element name="{local-name(.)}">
<xsl:call-template name="base-attributes"/>
<xsl:call-template name="alignment-attributes"/>
<xsl:apply-templates/>
</xsl:element>
</xsl:template>

<!-- td, th map directly
If applicable, include: abbr, align, axis, char, charoff, colspan, headers, rowspan, scope, valign -->
<xsl:template match="dtb:td | dtb:th">
<xsl:element name="td">
<xsl:call-template name="base-attributes"/>
<xsl:call-template name="alignment-attributes"/>
<xsl:if test="@abbr">
<xsl:attribute name="abbr"><xsl:value-of select="@abbr"/></xsl:attribute>
</xsl:if>
<xsl:if test="@axis">
<xsl:attribute name="axis"><xsl:value-of select="@axis"/></xsl:attribute>
</xsl:if>
<xsl:if test="@colspan">
<xsl:attribute name="colspan"><xsl:value-of select="@colspan"/></xsl:attribute>
</xsl:if>
<xsl:if test="@headers">
<xsl:attribute name="headers"><xsl:value-of select="@headers"/></xsl:attribute>
</xsl:if>
<xsl:if test="@rowspan">
<xsl:attribute name="rowspan"><xsl:value-of select="@rowspan"/></xsl:attribute>
</xsl:if>
<xsl:if test="@scope">
<xsl:attribute name="scope"><xsl:value-of select="@scope"/></xsl:attribute>
</xsl:if>

<xsl:apply-templates/>
</xsl:element>
</xsl:template>

<!--*************************
IMAGES
************************ *** -->

<!-- img maps directly
Include: alt, src
If applicable, include: longdesc, height, width
NOTE: img is self closing so no apply-templates necessary -->
<xsl:template match="dtb:img">
<xsl:element name="img">
<xsl:call-template name="base-attributes"/>
<xsl:attribute name="alt"><xsl:value-of select="@alt"/></xsl:attribute>
<xsl:attribute name="src"><xsl:value-of select="@src"/></xsl:attribute>
<xsl:if test="@longdesc">
<xsl:attribute name="longdesc"><xsl:value-of select="@longdesc"/></xsl:attribute>
</xsl:if>
<xsl:if test="@height">
<xsl:attribute name="height"><xsl:value-of select="@height"/></xsl:attribute>
</xsl:if>
<xsl:if test="@width">
<xsl:attribute name="width"><xsl:value-of select="@width"/></xsl:attribute>
</xsl:if>
</xsl:element>
</xsl:template>

<!-- imggroup maps to div with class -->
<xsl:template match="dtb:imggroup">
<div class="imggroup"><xsl:apply-templates/></div>
</xsl:template>

<!-- imggroup/caption maps to div with class
Excludes imgref - no way to express -->
<xsl:template match="dtb:imggroup/dtb:caption">
<div class="caption"><xsl:apply-templates/></div>
</xsl:template>

<!--*************************
Helpers
************************ *** -->

<!-- If applicable include id -->
<xsl:template name="base-attributes">
<xsl:if test="@id">
<xsl:attribute name="id"><xsl:value-of select="@id"/></xsl:attribute>
</xsl:if>
</xsl:template>

<!-- If applicable include align, char, charoff, valign -->
<xsl:template name="alignment-attributes">
<xsl:if test="@align">
<xsl:attribute name="align"><xsl:value-of select="@align"/></xsl:attribute>
</xsl:if>
<xsl:if test="@char">
<xsl:attribute name="char"><xsl:value-of select="@char"/></xsl:attribute>
</xsl:if>
<xsl:if test="@charoff">
<xsl:attribute name="charoff"><xsl:value-of select="@charoff"/></xsl:attribute>
</xsl:if>
<xsl:if test="@valign">
<xsl:attribute name="valign"><xsl:value-of select="@valign"/></xsl:attribute>
</xsl:if>
</xsl:template>

<!-- If applicable include: charset, href, hreflang, rel, rev, type -->
<xsl:template name="link-attributes">
<xsl:if test="@charset">
<xsl:attribute name="charset"><xsl:value-of select="@charset"/></xsl:attribute>
</xsl:if>
<xsl:if test="@href">
<xsl:attribute name="href"><xsl:value-of select="@href"/></xsl:attribute>
</xsl:if>
<xsl:if test="@hreflang">
<xsl:attribute name="hreflang"><xsl:value-of select="@hreflang"/></xsl:attribute>
</xsl:if>
<xsl:if test="@rel">
<xsl:attribute name="rel"><xsl:value-of select="@rel"/></xsl:attribute>
</xsl:if>
<xsl:if test="@rev">
<xsl:attribute name="rev"><xsl:value-of select="@rev"/></xsl:attribute>
</xsl:if>
<xsl:if test="@type">
<xsl:attribute name="type"><xsl:value-of select="@type"/></xsl:attribute>
</xsl:if>
</xsl:template>

</xsl:stylesheet>
                    */
                    let dtBookStr = await loadFileStrFromZipPath(resLink.Href, resLink.HrefDecoded, zip);
                    if (!dtBookStr) {
                        debug("!loadFileStrFromZipPath", dtBookStr);
                        continue;
                    }
                    dtBookStr = dtBookStr.replace(/xmlns=""/, " ");
                    dtBookStr = dtBookStr.replace(/<dtbook/, "<dtbook xmlns:epub=\"http://www.idpf.org/2007/ops\" ");
                    const dtBookDoc = new xmldom.DOMParser().parseFromString(dtBookStr, "application/xml");

                    let title = dtBookDoc.getElementsByTagName("doctitle")[0]?.textContent;
                    if (title) {
                        title = title.trim();
                        if (!title.length) {
                            title = null;
                        }
                    }

                    const listElements = dtBookDoc.getElementsByTagName("list");
                    for (let i = 0; i < listElements.length; i++) {
                        const listElement = listElements.item(i);
                        if (!listElement) {
                            continue;
                        }
                        const type = listElement.getAttribute("type");
                        if (type) {
                            // TODO: strictly-speaking, this is a read-only property!
                            (listElement as any).tagName = type;
                            // listElement.removeAttribute("type");
                        }
                    }

                    //             .replace(/(<\/?)imggroup/g, "$1figure")
                    //             .replace(/<caption/g, "<figcaption")
                    //             .replace(/<\/caption>/g, "</figcaption>");

                    for (const elementName of elementNames) {
                        // getElementsByName(elementName: string): NodeListOf<HTMLElement>
                        // ==> not available in the XMLDOM API
                        // getElementsByTagName(qualifiedName: string): HTMLCollectionOf<Element>
                        // ==> mutates during loop because of tagName reassignment!
                        const els = Array.from(dtBookDoc.getElementsByTagName(elementName)).filter((el) => el);
                        for (const el of els) {
                            el.setAttribute("data-dtbook", elementName);
                            const cls = el.getAttribute("class");
                            el.setAttribute("class", `${cls ? (cls + " ") : ""}${elementName}_R2`);
                            // TODO: strictly-speaking, this is a read-only property!
                            (el as any).tagName =
                                ((elementName === "dtbook") ? "html" :
                                    ((elementName === "book") ? "body" :
                                        ((elementName === "pagenum") ? "span" :
                                            ((elementName === "sent") ? "span" :
                                                ((elementName === "caption") ? "figcaption" :
                                                    ((elementName === "imggroup") ? "figure" :
                                                        (elementName === "sidebar") ? "aside" :
                                                            "div"))))));
                            if (elementName === "pagenum") {
                                // el.setAttributeNS("http://www.idpf.org/2007/ops", "type", "pagebreak");
                                el.setAttribute("epub:type", "pagebreak");
                            } else if (elementName === "annotation") {
                                // el.setAttributeNS("http://www.idpf.org/2007/ops", "type", "annotation");
                                el.setAttribute("epub:type", "annotation");
                            } else if (elementName === "note") {
                                // el.setAttributeNS("http://www.idpf.org/2007/ops", "type", "note");
                                el.setAttribute("epub:type", "note");
                            } else if (elementName === "prodnote") {
                                // el.setAttributeNS("http://www.idpf.org/2007/ops", "type", "note");
                                el.setAttribute("epub:type", "note");
                            } else if (elementName === "sidebar") {
                                // el.setAttributeNS("http://www.idpf.org/2007/ops", "type", "sidebar");
                                el.setAttribute("epub:type", "sidebar");
                            }
                        }
                    }

                    // <?xml-stylesheet type="text/css" href="dtbookbasic.css"?>
                    const stylesheets =
                        select("/processing-instruction('xml-stylesheet')", dtBookDoc) as ProcessingInstruction[];
                    const cssHrefs: string[] = []; // `<link rel="stylesheet" href="${cssHref}" />`
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
                        const href = match[2].trim();
                        if (href) {
                            cssHrefs.push(href);
                        }
                    }

                    const smilRefs = select("//*[@smilref]", dtBookDoc) as Element[];
                    for (const smilRef of smilRefs) {
                        const ref = smilRef.getAttribute("smilref");
                        if (ref) {
                            smilRef.setAttribute("data-smilref", ref);
                        }
                        smilRef.removeAttribute("smilref");
                    }

                    // does not work (element renamed via the tagName assignment still have the original NameSpaceURI,
                    // which gets serialized)
                    // dtBookDoc.documentElement.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");

                    // does not work (read only property):
                    // (dtBookDoc as any).doctype = null;
                    // ...so we use regexp replace below

                    const dtbookNowXHTML = new xmldom.XMLSerializer().serializeToString(dtBookDoc)
                        .replace(/xmlns="http:\/\/www\.daisy\.org\/z3986\/2005\/dtbook\/"/, "xmlns=\"http://www.w3.org/1999/xhtml\"")
                        .replace(/xmlns="http:\/\/www\.daisy\.org\/z3986\/2005\/dtbook\/"/g, " ")
                        .replace(/^([\s\S]*)<html/gm,
                            `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html `)
                        .replace(/<head([\s\S]*?)>/gm,
                            `
<head$1>
<meta charset="UTF-8" />
${title ? `<title>${title}</title>` : ""}
`)
                        .replace(/<\/head[\s\S]*?>/gm,
                            `
${cssHrefs.reduce((pv, cv) => {
                                return pv + "\n" + `<link rel="stylesheet" type="text/css" href="${cv}" />`;
                            }, "")}
</head>
`);
                    const xhtmlFilePath = resLink.HrefDecoded.replace(/\.(.+)$/, ".xhtml");

                    // const xhtmlOutputFilePath = path.join(outputDirPathExploded, xhtmlFilePath);
                    // ensureDirs(xhtmlOutputFilePath);
                    // fs.writeFileSync(xhtmlOutputFilePath, dtbookNowXHTML);
                    // zipfile.addFile(xhtmlOutputFilePath, xhtmlFilePath);
                    zipfile.addBuffer(Buffer.from(dtbookNowXHTML), xhtmlFilePath);

                    const resLinkJson = TaJsonSerialize(resLink);
                    // resLinkJson.href = xhtmlFilePath;
                    const resLinkClone = TaJsonDeserialize<Link>(resLinkJson, Link);
                    resLinkClone.setHrefDecoded(xhtmlFilePath);
                    resLinkClone.TypeLink = "application/xhtml+xml";

                    dtBooks.push(resLinkClone);

                } else if (!resLink.HrefDecoded.endsWith(".opf") &&
                    !resLink.HrefDecoded.endsWith(".res") &&
                    !resLink.HrefDecoded.endsWith(".ncx")) {

                    const buff = await loadFileBufferFromZipPath(resLink.Href, resLink.HrefDecoded, zip);
                    if (buff) {
                        zipfile.addBuffer(buff, resLink.HrefDecoded);
                    }

                    resourcesToKeep.push(resLink);

                    if (resLink.HrefDecoded.endsWith(".html") ||
                        resLink.TypeLink === "text/html") {
                        dtBooks.push(resLink);
                    }
                }
            }

            if (mediaOverlaysMap) {
                Object.keys(mediaOverlaysMap).forEach((smilTextRef) => {
                    if (!mediaOverlaysMap) { // compiler check
                        return;
                    }
                    debug("smilTextRef: " + smilTextRef);
                    const mos = mediaOverlaysMap[smilTextRef].mos;
                    if (mos.length === 1) { // single-item array
                        debug("smilTextRef [1]: " + smilTextRef);
                        return;
                    }

                    const mergedMediaOverlays = new MediaOverlayNode();
                    mergedMediaOverlays.SmilPathInZip = undefined;
                    mergedMediaOverlays.initialized = true;
                    mergedMediaOverlays.Role = [];
                    mergedMediaOverlays.Role.push("section");
                    mergedMediaOverlays.duration = 0;

                    let i = -1;
                    for (const mo of mos) {
                        i++;
                        if (mo.Children) {
                            debug(`smilTextRef [${i}]: ` + smilTextRef);

                            if (!mergedMediaOverlays.Children) {
                                mergedMediaOverlays.Children = [];
                            }
                            mergedMediaOverlays.Children = mergedMediaOverlays.Children.concat(mo.Children);

                            if (mo.duration) {
                                mergedMediaOverlays.duration += mo.duration;
                            }
                        }
                    }
                    mediaOverlaysMap[smilTextRef].mos = [mergedMediaOverlays]; // single-item array
                });

                const mediaOverlaysSequence = Object.keys(mediaOverlaysMap).map((smilTextRef) => {
                    if (!mediaOverlaysMap) { // compiler check
                        return undefined;
                    }
                    return {
                        index: mediaOverlaysMap[smilTextRef].index,
                        mo: mediaOverlaysMap[smilTextRef].mos[0], // single-item array, at this point
                        smilTextRef,
                    };
                }).filter((e) => e).sort((a, b) => {
                    // a less than b
                    if (a && b && a.index < b.index) {
                        return -1;
                    }
                    // a more than b
                    if (a && b && a.index > b.index) {
                        return 1;
                    }
                    // a === b
                    return 0;
                });

                for (const mediaOverlay of mediaOverlaysSequence) {
                    if (!mediaOverlay) { // compiler check
                        continue;
                    }
                    debug("mediaOverlay:", mediaOverlay.index, mediaOverlay.smilTextRef);

                    const dtBookLink = dtBooks.find((l) => {
                        return l.HrefDecoded ?
                            l.HrefDecoded.toLowerCase() === mediaOverlay.smilTextRef.toLowerCase()
                            : false;
                    });

                    if (!dtBookLink) {
                        debug("!!dtBookLink");
                    } else if (!dtBookLink.HrefDecoded ||
                            (dtBookLink.HrefDecoded.toLowerCase() !== mediaOverlay.smilTextRef.toLowerCase())) {
                        debug("dtBook.HrefDecoded !== mediaOverlay.smilTextRef",
                            dtBookLink.HrefDecoded, mediaOverlay.smilTextRef);
                    } else {
                        if (isFullTextAudio || isAudioOnly) {
                            dtBookLink.MediaOverlays = mediaOverlay.mo;

                            if (mediaOverlay.mo.duration) {
                                dtBookLink.Duration = mediaOverlay.mo.duration;
                            }

                            const moURL = `smil-media-overlays_${mediaOverlay.index}.json`;
                            // mediaOverlayURLPath + "?" +
                            //     mediaOverlayURLParam + "=" +
                            //     encodeURIComponent_RFC3986(
                            //         resLinkClone.HrefDecoded ? resLinkClone.HrefDecoded : resLinkClone.Href);

                            // legacy method:
                            if (!dtBookLink.Properties) {
                                dtBookLink.Properties = new Properties();
                            }
                            dtBookLink.Properties.MediaOverlay = moURL;

                            // new method:
                            // tslint:disable-next-line: max-line-length
                            // https://w3c.github.io/sync-media-pub/incorporating-synchronized-narration.html#with-webpub
                            if (!dtBookLink.Alternate) {
                                dtBookLink.Alternate = [];
                            }
                            const moLink = new Link();
                            moLink.Href = moURL;
                            moLink.TypeLink = "application/vnd.syncnarr+json";
                            moLink.Duration = dtBookLink.Duration;
                            dtBookLink.Alternate.push(moLink);

                            const jsonObjMO = TaJsonSerialize(mediaOverlay.mo);
                            const jsonStrMO = global.JSON.stringify(jsonObjMO, null, "  ");
                            zipfile.addBuffer(Buffer.from(jsonStrMO), moURL);

                            debug("dtBookLink IN SPINE:",
                                mediaOverlay.index, dtBookLink.HrefDecoded, dtBookLink.Duration, moURL);
                        } else {
                            debug("dtBookLink IN SPINE (no audio):", mediaOverlay.index, dtBookLink.HrefDecoded);
                        }
                        publication.Spine.push(dtBookLink);
                    }
                }
            }

            publication.Resources = resourcesToKeep;

            if (!publication.Metadata) {
                publication.Metadata = new Metadata();
            }
            // publication.Metadata.Source = "DAISY";
            if (!publication.Metadata.AdditionalJSON) {
                publication.Metadata.AdditionalJSON = {};
            }
            publication.Metadata.AdditionalJSON.ReadiumWebPublicationConvertedFrom =
                isAudioOnly ? "DAISY_audioNCX" : (isTextOnly ? "DAISY_textNCX" : "DAISY_audioFullText");

            const findFirstDescendantText = (parent: Element): Element | undefined => {
                if (parent.childNodes && parent.childNodes.length) {
                    // tslint:disable-next-line: prefer-for-of
                    for (let i = 0; i < parent.childNodes.length; i++) {
                        const child = parent.childNodes[i];
                        if (child.nodeType === 1) { // Node.ELEMENT_NODE
                            const element = child as Element;
                            if (element.localName && element.localName.toLowerCase() === "text") {
                                return element;
                            }
                        }
                    }
                    // tslint:disable-next-line: prefer-for-of
                    for (let i = 0; i < parent.childNodes.length; i++) {
                        const child = parent.childNodes[i];
                        if (child.nodeType === 1) { // Node.ELEMENT_NODE
                            const element = child as Element;
                            const found = findFirstDescendantText(element);
                            if (found) {
                                return found;
                            }
                        }
                    }
                }
                return undefined;
            };

            const processLink = async (link: Link) => {
                // relative to publication root (package.opf / ReadiumWebPubManifest.json)
                let href = link.HrefDecoded;
                if (!href) {
                    return;
                }
                if (isAudioOnly) {
                    link.setHrefDecoded(href.replace(/\.smil/, ".xhtml"));
                    return;
                }
                let fragment: string | undefined;
                if (href.indexOf("#") >= 0) {
                    const arr = href.split("#");
                    href = arr[0].trim();
                    fragment = arr[1].trim();
                }
                if (!href) {
                    return;
                }

                let smilDoc = smilDocs[href];
                if (!smilDoc) {
                    const smilStr = await loadFileStrFromZipPath(href, href, zip);
                    if (!smilStr) {
                        debug("!loadFileStrFromZipPath", smilStr);
                        return;
                    }
                    smilDoc = new xmldom.DOMParser().parseFromString(smilStr, "application/xml");
                    smilDocs[href] = smilDoc;
                }

                let targetEl = fragment ? smilDoc.getElementById(fragment) as Element : undefined;
                if (!targetEl) {
                    // const textElems = smilDoc.getElementsByTagName("text");
                    // if (textElems && textElems[0]) {
                    //     targetEl = textElems[0];
                    // }
                    targetEl = findFirstDescendantText(smilDoc.documentElement);
                }
                if (!targetEl) {
                    return;
                }
                if (targetEl.nodeName !== "text") {
                    // const textElems = select("//text", targetEl, true) as Element;
                    // if (textElems) {
                    //     targetEl = textElems;
                    // }
                    targetEl = findFirstDescendantText(targetEl);
                }
                if (!targetEl || targetEl.nodeName !== "text") {
                    return;
                }

                const src = targetEl.getAttribute("src");
                if (!src) {
                    return;
                }
                // TODO: path is relative to SMIL (not to publication root),
                // and .xml file extension replacement is bit weak / brittle
                // (but for most DAISY books, this is a reasonable expectation)
                link.Href = src.replace(/\.xml/, ".xhtml");
            };

            const processLinks = async (links: Link[]) => {
                for (const link of links) {
                    await processLink(link);
                    if (link.Children) {
                        await processLinks(link.Children);
                    }
                }
            };

            if (publication.PageList) {
                for (const link of publication.PageList) {
                    await processLink(link);
                }
            }

            if (publication.Landmarks) {
                for (const link of publication.Landmarks) {
                    await processLink(link);
                }
            }

            if (publication.TOC) {
                await processLinks(publication.TOC);
            }

            const jsonObj = TaJsonSerialize(publication);
            const jsonStr = global.JSON.stringify(jsonObj, null, "  ");
            zipfile.addBuffer(Buffer.from(jsonStr), "manifest.json");
        } catch (erreur) {
            debug(erreur);
        } finally {
            timeoutId = setTimeout(() => {
                timeoutId = undefined;
                reject("YAZL zip took too long!? " + outputZipPath);
            }, 10000);
            zipfile.end();
        }
    });
};
