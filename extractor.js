/**
 * Created by igorgo on 05.07.2017.
 */
let utils = require('./utils'),
    xpath = require('xpath'),
    Dom = require('xmldom').DOMParser,
    tomlify = require('tomlify-j0.4')

const contexts = [
    'Идентификатор записи',                 // 0
    'Идентификатор родительской записи',    // 1
    'Идентификатор каталога',               // 2
    'Идентификатор организации',            // 3
    'Идентификатор версии',                 // 4
    'Код раздела',                          // 5
    'Код родительского раздела',            // 6
    'Пользователь',                         // 7
    'NULL',                                 // 8
    'Идентификатор отмеченных записей',     // 9
    'Код мастер раздела',                   // 10
    'Идентификатор процесса',               // 11
    'Идентификатор мастер записи',          // 12
    'Метод вызова раздела'                  // 13
]

class Extractor {
    constructor(oci) {
        this.oci = oci
    }

    async _getClassRn() {
        utils.conU('... get reg num of class')
        let r = await this.oci.execute(
            'select RN from UNITLIST where UNITCODE = :CLASSCODE', [this.classCode]
        )
        if (r.rows.length > 0) {
            return r.rows[0].RN
        }
        else {
            throw 'Class not found'
        }
    }

    async getDomainsMeta() {
        let domainsMeta = await this._getMetadataDomainList()
        let domainsCond = await this._getConditionDomainList()
        let domains = [...new Set(domainsMeta.concat(domainsCond))].sort()
        let domainsData = []
        for (let i = 0; i < domains.length; i++) {
            let r = await this.oci.execute(`
                 select D.RN,
                        D.CODE,
                        DT.DATATYPE_TEXT,
                        DT.DATATYPE_SUBTEXT,
                        D.DATA_LENGTH,
                        D.DATA_PRECISION,
                        D.DATA_SCALE,
                        D.DEFAULT_STR,
                        D.DEFAULT_NUM,
                        D.DEFAULT_DATE,
                        D.ENUMERATED,
                        D.PADDING
                   from DMSDOMAINS D, V_DATATYPES DT
                  where D.CODE = :DOMAINCODE
                    and D.DATA_TYPE = DT.DATATYPE_NUMB
                    and D.DATA_SUBTYPE = DT.DATATYPE_SUBNUMB            
            `, [domains[i]])
            let domain = r.rows[0]
            let name = await this.getResources(domain.RN, 'DMSDOMAINS', 'NAME')
            let objDomain = {
                'Мнемокод': domain.CODE,
                'Наименование (RU)': name.RU,
                'Наименование (UK)': name.UK,
                'Тип данных': domain.DATATYPE_TEXT,
                'Подтип данных': domain.DATATYPE_SUBTEXT,
                'Размер строки': domain.DATA_LENGTH,
                'Точность данных': domain.DATA_PRECISION,
                'Дробность данных': domain.DATA_SCALE,
                'Значение по умолчанию': utils.coalesce(domain.DEFAULT_STR, domain.DEFAULT_NUM, domain.DEFAULT_DATE),
                'Выравнивать по длине': !!domain.PADDING,
                'Имеет перечисляемые значения': !!domain.ENUMERATED,
                'Перечисляемые значения': domain.ENUMERATED ?
                    {'Перечисляемое значение': this._getDomainEnums(domain.RN)}
                    : null
            }
            domainsData.push(objDomain)
        }
        return domainsData
    }

    async _getDomainEnums(domainRn) {
        let enumsData = []
        let enumRows = await this.oci.execute(`
                    select RN,
                           POSITION,
                           VALUE_STR,
                           VALUE_NUM,
                           VALUE_DATE
                      from DMSENUMVALUES T
                     where PRN = :PRN
                     order by POSITION`,
            [domainRn])
        for (let i = 0; i < enumRows.rows.length; i++) {
            let enumRow = enumRows.rows[i]
            let enumName = await this.getResources(enumRow.RN, 'DMSENUMVALUES', 'NAME')
            let objEnum = {
                'Позиция': enumRow.POSITION.trim(),
                'Значение': utils.coalesce(enumRow.VALUE_STR, enumRow.VALUE_NUM, enumRow.VALUE_DATE),
                'Наименование (RU)': enumName.RU,
                'Наименование (UK)': enumName.UK,
            }
            enumsData.push(objEnum)
        }
        return enumsData
    }

    async _getMetadataDomainList() {
        utils.conU('... get list of metadata\'s domains')
        let r = await this.oci.execute(`
                select CODE
                  from DMSDOMAINS
                 where RN in (select DOMAIN
                                from DMSCLATTRS
                               where PRN = :CLASSRN
                              union
                              select DOMAIN
                                from DMSCLACTIONSPRM T, UNITFUNC F
                               where F.PRN = :CLASSRN
                                 and T.PRN = F.RN
                              union
                              select DOMAIN
                                from DMSCLMETPARMS T, DMSCLMETHODS M
                               where M.PRN = :CLASSRN
                                 and T.PRN = M.RN
                              union
                              select DOMAIN
                                from DMSCLVIEWSPARAMS T, DMSCLVIEWS V
                               where V.PRN = :CLASSRN
                                 and T.PRN = V.RN)`,
            [this.classRn]
        )
        return r.rows.map((row) => {
            return row.CODE
        })
    }

    async _getConditionDomainList() {
        utils.conU('... get list of conditions\' domains')
        let r = await this.oci.execute(`
                select settings as SETS
                  from UNIT_SHOWMETHODS
                 where PRN = :CLASSRN
                   and LENGTH(SETTINGS) > 0`,
            [this.classRn])
        let res = []
        let nodeVals
        for (let i = 0; i < r.rows.length; i++) {
            let doc = new Dom().parseFromString(r.rows[i].SETS)
            let nodes = xpath.select('/ShowMethod/Group/DataSource/Params/ConditionParams/Param/@Domain', doc)
            nodeVals = nodes.map((node) => {
                return node.value
            })
            res = res.concat(nodeVals)
        }
        return res
    }

    async getClassMeta() {
        let classObject
        utils.conU('... get class definition')
        let classQuery = await this.oci.execute(`
             select CL.*,
                    (select I.CODE from SYSIMAGES I where I.RN = CL.SYSIMAGE) as SSYSIMAGE,
                    UA.CODE as SDOCFORM
               from UNITLIST CL, UAMODULES UA
              where CL.RN = :CLASSRN
                and CL.DOCFORM = UA.RN(+)`,
            [this.classRn])
        let classRow = classQuery.rows[0]
        let className = await this.getResources(classRow.RN, 'UNITLIST', 'UNITNAME')
        await this.saveIcons(this.classDir, classRow.SSYSIMAGE)
        classObject = {
            'Код': classRow.UNITCODE,
            'Наименование (RU)': className.RU,
            'Наименование (UK)': className.UK,
            'Абстрактный': !!classRow.ABSTRACT,
            'Буферный': !!classRow.SIGN_BUFFER,
            'Ведомый': !!classRow.SIGN_DRIVEN,
            'Ведущий раздел': classRow.HOSTCODE,
            'Деление': ['Нет деления', 'По версиям', 'По организациям'][classRow.SIGN_SHARE],
            'Юридические лица': !!classRow.SIGN_JURPERS,
            'Иерархия': !!classRow.HIERARCHICAL,
            'Каталоги': !!classRow.SIGN_HIER,
            'Свойства документов': !!classRow.USE_DOCPROPS,
            'Присоединенные документы': !!classRow.USE_FILELINKS,
            'Процедура считывания значений атрибутов': classRow.GET_PROCEDURE,
            'Форма раздела': classRow.SDOCFORM,
            'Пиктограмма': classRow.SSYSIMAGE,
            'Таблица': classRow.TABLE_NAME ? await this._getTableMeta(classRow.TABLE_NAME) : null,
            'Атрибуты': {
                'Атрибут': await this._getAttributesMeta()
            },
            'Ограничения': {
                'Ограничение': await this._getConstraintsMeta()
            },
            'Связи': {
                'Связь': await this._getLinksMeta()
            },
            'Представления': {
                'Представление': await this._getViewsMeta()
            },
            'Методы вызова': {
                'Метод вызова': await this._getShowMethodsMeta()
            },
            'Методы': {
                'Метод': await this._getMethodsMeta()
            }
        }
        return classObject
    }

    async _getTableMeta(tableName) {
        utils.conU('... get table definition')
        const query = await this.oci.execute(
            'select TL.* from TABLELIST TL where TL.TABLENAME = :TABLENAME',
            [tableName])
        const res = query.rows[0]
        const names = await this.getResources(res.RN, 'TABLELIST', 'TABLENOTE')
        return {
            'Имя': res.TABLENAME,
            'Наименование (RU)': names.RU,
            'Наименование (UK)': names.UK,
            'Тип информации': ['Постоянная', 'Временная'][res.TEMPFLAG],
            'Технология производства': ['Стандарт', 'Конструктор'][res.TECHNOLOGY]
        }
    }

    async _getAttributesMeta() {
        utils.conU('... get attributes\' metadata')
        const attrsQuery = await this.oci.execute(`
                select CA.*,
                       DM.CODE            as SDOMAIN,
                       CL.CONSTRAINT_NAME as SREF_LINK,
                       CAR.COLUMN_NAME    as SREF_ATTRIBUTE
                  from DMSCLATTRS CA, DMSDOMAINS DM, DMSCLLINKS CL, DMSCLATTRS CAR
                 where CA.PRN = :CLASSRN
                   and CA.DOMAIN = DM.RN
                   and CA.REF_LINK = CL.RN(+)
                   and CA.REF_ATTRIBUTE = CAR.RN(+)
                 order by CA.POSITION `,
            [this.classRn])
        let attrs = []
        for (let i = 0, len = attrsQuery.rows.length; i < len; i++) {
            const attr = attrsQuery.rows[i]
            const names = await this.getResources(attr.RN, 'DMSCLATTRS', 'CAPTION')
            attrs.push({
                'Имя': attr.COLUMN_NAME,
                'Наименование (RU)': names.RU,
                'Наименование (UK)': names.UK,
                'Позиция': attr.POSITION,
                'Тип': ['Физический', 'Логический', 'Получен по связи'][attr.KIND],
                'Домен': attr.SDOMAIN,
                'Связь': attr.SREF_LINK,
                'Атрибут связи': attr.SREF_ATTRIBUTE
            })
        }
        return attrs
    }

    async _getConstraintsMeta() {
        utils.conU('... get constraints\' metadata')
        const query = await this.oci.execute(`
                select T.*,
                       MES.CODE       as MES_CODE,
                       MES.TECHNOLOGY as MES_TECHNOLOGY,
                       MES.KIND       as MES_KIND
                  from DMSCLCONSTRS T, DMSMESSAGES MES
                 where T.PRN = :CLASSRN
                   and T.MESSAGE = MES.RN(+)
                 order by T.CONSTRAINT_TYPE, T.CONSTRAINT_NAME
            `, [this.classRn])
        let constrs = []
        for (let i = 0, len = query.rows.length; i < len; i++) {
            const constr = query.rows[i]
            const names = await this.getResources(constr.RN, 'DMSCLCONSTRS', 'CONSTRAINT_NOTE')
            const messages = await this.getResources(constr.MESSAGE, 'DMSMESSAGES', 'TEXT')
            constrs.push({
                'Имя': constr.CONSTRAINT_NAME,
                'Наименование (RU)': names.RU,
                'Наименование (UK)': names.UK,
                'Тип': [
                    'Уникальность',
                    'Первичный ключ',
                    'Проверка',
                    '?',
                    '?',
                    'Обязательность',
                    'Неизменяемость'
                ][constr.CONSTRAINT_TYPE],
                'Использовать для разрешения ссылок': !!constr.LINKS_SIGN,
                'Текст ограничения': constr.CONSTRAINT_TEXT,
                'Сообщение при нарушениии': {
                    'Мнемокод': constr.MES_CODE,
                    'Технология производства': ['Стандарт', 'Конструктор'][constr.MES_TECHNOLOGY],
                    'Тип': ['Сообщение ограничения', 'Сообщение исключения'][constr.MES_KIND],
                    'Текст (RU)': messages.RU,
                    'Текст (UK)': messages.UK
                },
                'Атрибуты': {
                    'Атрибут': await this._getConstraintAttributesMeta(constr.RN)
                }
            })
        }
        return constrs
    }

    async _getConstraintAttributesMeta(constrRn) {
        let query = await this.oci.execute(`
                        select T.POSITION, TR1.COLUMN_NAME
                          from DMSCLCONATTRS T, DMSCLATTRS TR1
                         where T.PRN = :A_CONS
                           and T.ATTRIBUTE = TR1.RN
                         order by T.POSITION
                     `, [constrRn])
        return query.rows.map((attr) => {
            return {
                'Позиция': attr.POSITION,
                'Атрибут': attr.COLUMN_NAME
            }
        })
    }

    async _getLinksMeta() {
        utils.conU('... get links\' metadata')
        const query = await this.oci.execute(`
                select T.RN,
                       T.CONSTRAINT_NAME,
                       US.UNITCODE,
                       ST.CODE            as SSTEREOTYPE,
                                T.FOREIGN_KEY,
                       CC.CONSTRAINT_NAME as SSRC_CONSTRAINT,
                       T.RULE,
                       L.CONSTRAINT_NAME  as SMASTER_LINK,
                       M1.CODE            as SMESSAGE1,
                       M2.CODE            as SMESSAGE2,
                       LA.COLUMN_NAME     as SLEVEL_ATTR,
                       PA.COLUMN_NAME     as SPATH_ATTR
                  from DMSCLLINKS   T,
                       UNITLIST     US,
                       DMSLSTYPES   ST,
                       DMSCLCONSTRS CC,
                       DMSCLLINKS   L,
                       DMSMESSAGES  M1,
                       DMSMESSAGES  M2,
                       DMSCLATTRS   LA,
                       DMSCLATTRS   PA
                 where T.DESTINATION = :WORKIN_CLASS
                   and T.SOURCE = US.RN
                   and T.STEREOTYPE = ST.RN(+)
                   and T.SRC_CONSTRAINT = CC.RN(+)
                   and T.MASTER_LINK = L.RN(+)
                   and T.MESSAGE1 = M1.RN(+)
                   and T.MESSAGE2 = M2.RN(+)
                   and T.LEVEL_ATTR = LA.RN(+)
                   and T.PATH_ATTR = PA.RN(+)
                 order by T.CONSTRAINT_NAME`,
            [this.classRn])
        let links = []
        for (let i = 0, l = query.rows.length; i < l; i++) {
            const link = query.rows[i]
            const names = await this.getResources(link.RN, 'DMSCLLINKS', 'CONSTRAINT_NOTE')
            links.push({
                'Код': link.CONSTRAINT_NAME,
                'Наименование (RU)': names.RU,
                'Наименование (UK)': names.UK,
                'Класс-источник': link.UNITCODE,
                'Стереотип': link.SSTEREOTYPE,
                'Физическая связь': !!link.FOREIGN_KEY,
                'Ограничение класса-источника': link.SSRC_CONSTRAINT,
                'Правило': ['Нет правил', 'Каскадное удаление'][link.RULE],
                'Мастер-связь': link.SMASTER_LINK,
                'Сообщение при нарушениии cо стороны источника': link.SMESSAGE1,
                'Сообщение при нарушениии cо стороны приемника': link.SMESSAGE2,
                'Атрибут уровня иерархии': link.SLEVEL_ATTR,
                'Атрибут полного имени иерархии': link.SPATH_ATTR,
                'Атрибуты': {
                    'Атрибут': await this._getLinkAttributesMeta()
                }
            })
        }
        return links
    }

    async _getLinkAttributesMeta(linkRn) {
        const query = await this.oci.execute(`
                        select T.POSITION,
                               TR1.COLUMN_NAME as SSOURCE,
                               TR2.COLUMN_NAME as SDESTINATION
                          from DMSCLLINKATTRS T,
                               DMSCLATTRS     TR1,
                               DMSCLATTRS     TR2
                         where T.PRN = :A_LINK
                           and T.SOURCE = TR1.RN
                           and T.DESTINATION = TR2.RN
                         order by T.POSITION`,
            [linkRn])
        let attrs = []
        for (let i = 0, l = query.rows.length; i < l; i++) {
            const attr = query.rows[i]
            attrs.push({
                'Позиция': attr.POSITION,
                'Атрибут класса-приемника': attr.SDESTINATION,
                'Атрибут класса-источника': attr.SSOURCE
            })
        }
        return attrs
    }

    async _getViewsMeta() {
        utils.conU('... get views\' metadata')
        const query = await this.oci.execute(`
                select T.RN,
                       T.VIEW_NAME,
                       T.CUSTOM_QUERY,
                       T.ACCESSIBILITY,
                       T.QUERY_SQL
                  from DMSCLVIEWS T
                 where T.PRN = :WORKIN_CLASS
                 order by T.VIEW_NAME`,
            [this.classRn])
        let views = []
        for (let i = 0, l = query.rows.length; i < l; i++) {
            const view = query.rows[i]
            const names = await this.getResources(view.RN, 'DMSCLVIEWS', 'VIEW_NOTE')
            views.push({
                'Имя': view.VIEW_NAME,
                'Наименование (RU)': names.RU,
                'Наименование (UK)': names.UK,
                'Тип': ['Представление', 'Запрос'][view.CUSTOM_QUERY],
                'Вызывается с клиента': !!view.ACCESSIBILITY,
                'Текст запроса': view.QUERY_SQL,
                'Параметры': {
                    'Параметр': view.CUSTOM_QUERY ? await this._getViewParamsMeta(view.RN) : null
                },
                'Атрибуты': {
                    'Атрибут': await this._getViewAttributesMeta(view.RN)
                }
            })
        }
        return views
    }

    async _getViewParamsMeta(viewRn) {
        let params = []
        const paramsQuery = await this.oci.execute(`
                        select T.PARAM_NAME,
                               D.CODE as SDOMAIN
                          from DMSCLVIEWSPARAMS T,
                               DMSDOMAINS       D
                         where T.PRN = :A_VIEW
                           and T.DOMAIN = D.RN
                         order by T.PARAM_NAME`,
            [viewRn])
        for (let i = 0, l = paramsQuery.rows.length; i < l; i++) {
            const param = paramsQuery.rows[i]
            params.push({
                'Наименование параметра': param.PARAM_NAME,
                'Домен': param.SDOMAIN
            })
        }
        return params
    }

    async _getViewAttributesMeta(viewRn) {
        let attrs = []
        const query = await this.oci.execute(`
                        select A.POSITION,
                               A.COLUMN_NAME as SATTR,
                               T.COLUMN_NAME
                          from DMSCLVIEWSATTRS T,
                               DMSCLATTRS      A
                         where T.PRN = :A_VIEW
                           and T.ATTR = A.RN
                         order by A.POSITION`,
            [viewRn])
        for (let i = 0, l = query.rows.length; i < l; i++) {
            const attr = query.rows[i]
            attrs.push({
                'Атрибут класса': attr.SATTR,
                'Имя колонки': attr.COLUMN_NAME
            })
        }
        return attrs
    }

    async _getMethodsMeta() {
        let methods = []
        utils.conU('... get methods\' metadata')
        const q = await this.oci.execute(`
                select T.RN,
                       T.CODE,
                       T.METHOD_TYPE,
                       T.ACCESSIBILITY,
                       T.PACKAGE,
                       T.NAME,
                       (select D.CODE
                          from DMSCLMETPARMS P,
                               DMSDOMAINS    D
                         where P.DOMAIN = D.RN
                           and P.PRN = T.RN
                           and P.NAME = 'RESULT'
                           and T.METHOD_TYPE = 1) as SRESULT_DOMAIN
                  from DMSCLMETHODS T
                 where T.PRN = :WORKIN_CLASS
                 order by T.CODE`,
            [this.classRn])
        for (let i = 0, l = q.rows.length; i < l; i++) {
            const m = q.rows[i]
            const names = await
                this.getResources(m.RN, 'DMSCLMETHODS', 'NOTE')
            const comments = await
                this.getResources(m.RN, 'DMSCLMETHODS', 'COMMENT')
            methods.push({
                'Мнемокод': m.CODE,
                'Тип метода': ['Процедура', 'Функция'][m.METHOD_TYPE],
                'Доступность': ['Базовый', 'Клиентский'][m.ACCESSIBILITY],
                'Пакет': m.PACKAGE,
                'Процедура/функция': m.NAME,
                'Наименование (RU)': names.RU,
                'Наименование (UK)': names.UK,
                'Примечание (RU)': comments.RU,
                'Примечание (UK)': comments.UK,
                'Домен результата функции': m.SRESULT_DOMAIN,
                'Параметры': {
                    'Параметр': await this._getMethodParamsMeta(m.RN)
                }
            })
        }
        return methods
    }

    async _getMethodParamsMeta(methodRn) {
        let params = []
        const query = await this.oci.execute(`
                    select T.RN,
                           T.POSITION,
                           T.NAME,
                           T.INOUT,
                           D.CODE         as SDOMAIN,
                           T.LINK_TYPE,
                           A.COLUMN_NAME,
                           T.DEF_NUMBER,
                           T.CONTEXT,
                           T.DEF_STRING,
                           T.DEF_DATE,
                           F.CODE         as LINKED_FUNCTION,
                           T.ACTION_PARAM,
                           T.MANDATORY
                      from DMSCLMETPARMS T,
                           DMSDOMAINS    D,
                           DMSCLATTRS    A,
                           DMSCLMETHODS  F
                     where T.PRN = :A_METHOD
                       and T.DOMAIN = D.RN
                       and T.LINK_ATTR = A.RN(+)
                       and T.LINKED_FUNCTION = F.RN(+)
                     order by T.POSITION`,
            [methodRn])
        for (let i = 0, l = query.rows.length; i < l; i++) {
            const param = query.rows[i]
            const names = await this.getResources(param.RN, 'DMSCLMETPARMS', 'NOTE')
            params.push({
                'Имя': param.NAME,
                'Наименование (RU)': names.RU,
                'Наименование (UK)': names.UK,
                'Позиция': param.POSITION,
                'Тип': ['Входной/выходной (in/out)', 'Входной (in)', 'Выходной (out)'][param.INOUT],
                'Домен': param.SDOMAIN,
                'Тип привязки': [
                    'Нет',
                    'Атрибут',
                    'Контекст',
                    'Значение',
                    'Результат функции',
                    'Параметр действия'
                ][param.LINK_TYPE],
                'Атрибут': param.COLUMN_NAME,
                'Значение': (param.DEF_NUMBER || param.DEF_STRING || param.DEF_DATE) ? utils.coalesce([param.DEF_NUMBER, param.DEF_STRING, param.DEF_DATE]) : null,
                'Контекст': contexts[param.CONTEXT],
                'Функция': param.LINKED_FUNCTION,
                'Параметр действия': param.ACTION_PARAM,
                'Обязательный для заполнения': !!param.MANDATORY
            })
        }
        return params
    }

    async _getShowMethodsMeta() {
        const settingsFileName = 'Settings.xml'
        let showMethods = []
        utils.conU('... get show methods\' metadata')
        const query = await this.oci.execute(`
                  select SM.RN,
                         SM.METHOD_CODE,
                         SM.TECHNOLOGY,
                         (select I.CODE
                            from SYSIMAGES I
                           where I.RN = SM.SYSIMAGE) as SSYSIMAGE,
                         SM.COND_TYPE,
                         SM.USEFORVIEW,
                         SM.USEFORLINKS,
                         SM.USEFORDICT,
                         SM.SETTINGS
                    from UNIT_SHOWMETHODS SM
                   where SM.PRN = :WORKIN_CLASS
                          order by SM.TECHNOLOGY,
                     SM.METHOD_CODE`,
            [this.classRn])
        for (let i = 0, l = query.rows.length; i < l; i++) {
            const showMethod = query.rows[i]
            const names = await this.getResources(showMethod.RN, 'UNIT_SHOWMETHODS', 'METHOD_NAME')
            const relpath = `/ShowMethods/${showMethod.METHOD_CODE}`
            if (showMethod.SSYSIMAGE) await this.saveIcons(this.classDir + relpath, showMethod.SSYSIMAGE)
            if (showMethod.SETTINGS) await utils.saveClob1251Xml(showMethod.SETTINGS, this.classDir + relpath, settingsFileName)
            showMethods.push({
                'Мнемокод': showMethod.METHOD_CODE,
                'Наименование (RU)': names.RU,
                'Наименование (UK)': names.UK,
                'Технология производства': ['Стандарт', 'Конструктор'][showMethod.TECHNOLOGY],
                'Пиктограмма': showMethod.SSYSIMAGE,
                'Тип условий отбора': ['Клиент', 'Сервер'][showMethod.COND_TYPE],
                'Использовать для отображения по умолчанию': !!showMethod.USEFORVIEW,
                'Использовать для отображения через связи документов': !!showMethod.USEFORLINKS,
                'Использовать для отображения в качестве словаря': !!showMethod.USEFORDICT,
                'Настройка': showMethod.SETTINGS ? `.${relpath}/${settingsFileName}` : null,
                'Параметры': {
                    'Параметр': await this._getShowMethodParamsMeta(showMethod.RN)
                },
                'Формы': {
                    'Форма': await this._getShowMethodFormsMeta(showMethod.RN, relpath)
                }
            })
        }
        return showMethods
    }

    async _getShowMethodParamsMeta(showMethodRn) {
        let params = []
        const query = await this.oci.execute(`
                    select MP.RN,
                           CA.COLUMN_NAME,
                           MP.IN_CODE,
                           MP.OUT_CODE,
                           MP.DATA_TYPE,
                           MP.DIRECT_SQL,
                           MP.BACK_SQL
                      from UNITPARAMS MP,
                           DMSCLATTRS CA
                     where MP.PARENT_METHOD = :A_METHOD
                       and MP.ATTRIBUTE = CA.RN(+)
                     order by MP.TECHNOLOGY,
                              MP.IN_CODE,
                              MP.OUT_CODE`,
            [showMethodRn])
        for (let i = 0; i < query.rows.length; i++) {
            const param = query.rows[i]
            const names = await this.getResources(param.RN, 'UNITPARAMS', 'PARAMNAME')
            params.push({
                'Атрибут класса': param.COLUMN_NAME,
                'Наименование (RU)': names.RU,
                'Наименование (UK)': names.UK,
                'Имя входного параметра': param.IN_CODE,
                'Имя выходного параметра': param.OUT_CODE,
                'Тип данных': ['Строка', 'Дата', 'Число'][param.DATA_TYPE],
                'Прямой запрос': param.DIRECT_SQL,
                'Обратный запрос': param.BACK_SQL
            })
        }
        return params
    }

    async _getShowMethodFormsMeta(showMethodRn, startPath) {
        let forms = []
        const query = await this.oci.execute(`
                   select T.RN,
                          T.FORM_CLASS,
                          T.FORM_NAME,
                          T.EVENTS_LANGUAGE,
                          F_USERFORMS_GET_UAMODULE(T.FORM_UAMODULE) as SFORM_UAMODULE,
                          T.FORM_LANGUAGE,
                          T.FORM_ACTIVE,
                          T.LINK_APPS,
                          T.LINK_PRIVS,
                          T.FORM_DATA,
                          T.FORM_EVENTS,
                          T.FORM_DATA_EXT,
                          T.FORM_EVENTS_EXT
                     from USERFORMS T
                    where SHOW_METHOD = :A_METHOD
                      and FORM_KIND = 5
                      and FORM_ID = 0
                    order by T.FORM_CLASS,
                             T.FORM_LANGUAGE`,
            [showMethodRn])
        for (let i = 0; i < query.rows.length; i++) {
            forms.push(await this._getFormMetadata(query.rows[i], startPath))
        }
        return forms
    }

    async _getFormMetadata(formRecord, startPath) {
        const formDataName = 'Form.xml'
        const formEventsName = 'Events'
        const condDataName = 'ConditionForm.xml'
        const condEventsName = 'ConditionEvents'
        const relPath = `${startPath}/Forms/${formRecord.FORM_CLASS}`
        const eventExt = formRecord.EVENTS_LANGUAGE ? ['vbs', 'js', 'pas', 'pl', 'py'][formRecord.EVENTS_LANGUAGE] : 'txt'
        if (formRecord.FORM_DATA) await utils.saveClob1251Xml(formRecord.FORM_DATA, this.classDir + relPath, `${formRecord.FORM_LANGUAGE}_${formDataName}`)
        if (formRecord.FORM_EVENTS) await utils.saveClob(formRecord.FORM_EVENTS, this.classDir + relPath, `${formRecord.FORM_LANGUAGE}_${formEventsName}.${eventExt}`)
        if (formRecord.FORM_DATA_EXT) await utils.saveClob1251Xml(formRecord.FORM_DATA_EXT, this.classDir + relPath, `${formRecord.FORM_LANGUAGE}_${condDataName}`)
        if (formRecord.FORM_EVENTS_EXT) await utils.saveClob(formRecord.FORM_EVENTS_EXT, this.classDir + relPath, `${formRecord.FORM_LANGUAGE}_${condEventsName}.${eventExt}`)
        return {
            'Имя': formRecord.FORM_CLASS,
            'Наименование': formRecord.FORM_NAME,
            'Тип скрипта': formRecord.EVENTS_LANGUAGE ? ['VBScript', 'JScript', 'DelphiScript', 'PerlScript', 'PythonScript'][formRecord.EVENTS_LANGUAGE] : null,
            'Пользовательское приложение (форма)': formRecord.SFORM_UAMODULE,
            'Национальный язык формы': formRecord.FORM_LANGUAGE,
            'Доступна для использования': !!formRecord.FORM_ACTIVE,
            'Учитывать связи с приложениями': !!formRecord.LINK_APPS,
            'Учитывать назначение пользователям, ролям': !!formRecord.LINK_PRIVS,
            'Приложения': formRecord.LINK_APPS ? {
                'Приложение': await this._getFormApplications(formRecord.RN)
            } : null,
            'Файл': formRecord.FORM_DATA ? `.${relPath}/${formRecord.FORM_LANGUAGE}_${formDataName}` : null
        }
    }

    async _getFormApplications(formRn) {
        let apps = []
        const query = await this.oci.execute(`
                        select FLA.APPCODE
                          from USERFORMLNKAPPS FLA
                         where FLA.PRN = :A_FORM_RN
                         order by FLA.APPCODE`,
            [formRn])
        for (let i = 0, l = query.rows.length; i < l; i++) {
            apps.push({
                'Код': query.rows[i].APPCODE
            })
        }
        return apps
    }

    async saveIcons(path, code) {
        utils.conU('... saving the icons')
        let query = await this.oci.execute(
            ' select SY.*  from SYSIMAGES SY  where code = :CODE',
            [code]
        )
        let icon = query.rows[0]
        await utils.saveBlob(icon.SMALL_IMAGE, path, `${icon.CODE}_16.bmp`)
        await utils.saveBlob(icon.LARGE_IMAGE, path, `${icon.CODE}_24.bmp`)
    }

    async getResources(rn, tab, col) {
        let res = {
            RU: null,
            UK: null
        }
        let r = await
            this.oci.execute(`
        select RESOURCE_LANG,
               RESOURCE_TEXT
          from RESOURCES
         where TABLE_NAME = :ATAB
           and RESOURCE_NAME = :ACOL
           and TABLE_ROW = :ANRN`,
                {
                    ATAB: tab,
                    ACOL: col,
                    ANRN: rn
                })
        for (let i = 0, len = r.rows.length; i < len; i++) {
            if (r.rows[i].RESOURCE_LANG === 'RUSSIAN') res.RU = (r.rows[i].RESOURCE_TEXT)
            if (r.rows[i].RESOURCE_LANG === 'UKRAINIAN') res.UK = (r.rows[i].RESOURCE_TEXT)
        }
        return res
    }

    async extractClass(classCode, dir) {
        this.classCode = classCode
        this.dir = dir
        this.classDir = this.dir + '/' + this.classCode
        this.classRn = await this._getClassRn()
        utils.conE(`Processing class ${this.classCode}...`)
        const tomlContent = {
            'Используемые домены': {
                'Домен': await this.getDomainsMeta()
            },
            'Класс': await this.getClassMeta()
        }
        await utils.saveClob(tomlify(tomlContent, null, 4),this.classDir,'Metadata.toml')
        utils.conU('  ...done')
        return {
            classRn: this.classRn,
            classCode: this.classCode,
            classDir: this.classDir
        }
    }
    get classRegNum() {
        return this.classRn
    }

}

// todo: extract actions
// todo: extract objects
// todo: extract options

module.exports = Extractor